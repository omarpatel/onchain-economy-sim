//! On-chain corporate equity for Economy Sim companies.
//!
//! When a company "graduates" from the off-chain internal exchange, the
//! protocol authority (the settlement worker, mirroring the simulation's
//! graduation gate) lists it on-chain: a fixed cap table is minted as an SPL
//! share token and the mint authority is revoked (no dilution, ever). Founder
//! shares sit in a program-owned escrow vault until `founder_unlock_ts`; the
//! public float is sold for $ECON (primary raise -> the company treasury).
//! Secondary trading then happens on an AMM/CLOB, and profit distributions are
//! handled by the `dividends` merkle-distributor program.
//!
//! Listing is gated by a singleton `Config` PDA (`["config"]`) holding the
//! protocol authority, so nobody can mint a bogus cap table for an
//! ungraduated company. Company PDAs are seeded by
//! `["company", founder, company_id]`, so two founders can never collide on
//! (or front-run) the same company id.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, CloseAccount, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};

declare_id!("72UFK1K2KkxG8nowVkU5Yoj9TfhjiC9d4awmHW3rGcvT");

#[program]
pub mod equity {
    use super::*;

    /// One-time protocol setup: record the authority allowed to list
    /// companies. The singleton PDA makes a second call fail.
    pub fn init_config(ctx: Context<InitConfig>, authority: Pubkey) -> Result<()> {
        let c = &mut ctx.accounts.config;
        c.authority = authority;
        c.bump = ctx.bumps.config;
        Ok(())
    }

    /// List a company on-chain (protocol authority only): mint the full cap
    /// table, split founder (escrowed until `founder_unlock_ts`) vs. public
    /// float (held in a sale vault for the IPO), then revoke the mint
    /// authority. `founder` becomes the company authority and need not sign;
    /// the protocol authority pays the rent.
    pub fn list_company(
        ctx: Context<ListCompany>,
        company_id: [u8; 16],
        total_shares: u64,
        float_shares: u64,
        ipo_price_econ: u64,
        founder_unlock_ts: i64,
    ) -> Result<()> {
        require!(total_shares > 0, EquityError::ZeroShares);
        require!(float_shares <= total_shares, EquityError::BadFloat);
        require!(ipo_price_econ > 0, EquityError::ZeroPrice);
        let founder_shares = total_shares - float_shares;

        let co = &mut ctx.accounts.company;
        co.company_id = company_id;
        co.authority = ctx.accounts.founder.key();
        co.share_mint = ctx.accounts.share_mint.key();
        co.econ_mint = ctx.accounts.econ_mint.key();
        co.treasury = ctx.accounts.treasury.key();
        co.founder_vault = ctx.accounts.founder_vault.key();
        co.sale_vault = ctx.accounts.sale_vault.key();
        co.total_shares = total_shares;
        co.float_shares = float_shares;
        co.shares_sold = 0;
        co.ipo_price_econ = ipo_price_econ;
        co.founder_unlock_ts = founder_unlock_ts;
        co.founder_released = false;
        co.bump = ctx.bumps.company;

        let founder = ctx.accounts.founder.key();
        let seeds: &[&[u8]] = &[b"company", founder.as_ref(), company_id.as_ref(), &[co.bump]];
        let signer = &[seeds];

        if founder_shares > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.share_mint.to_account_info(),
                        to: ctx.accounts.founder_vault.to_account_info(),
                        authority: ctx.accounts.company.to_account_info(),
                    },
                    signer,
                ),
                founder_shares,
            )?;
        }
        if float_shares > 0 {
            token::mint_to(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    MintTo {
                        mint: ctx.accounts.share_mint.to_account_info(),
                        to: ctx.accounts.sale_vault.to_account_info(),
                        authority: ctx.accounts.company.to_account_info(),
                    },
                    signer,
                ),
                float_shares,
            )?;
        }
        // Fixed cap table: nobody can ever mint more shares.
        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.company.to_account_info(),
                    account_or_mint: ctx.accounts.share_mint.to_account_info(),
                },
                signer,
            ),
            token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;
        Ok(())
    }

    /// Buy IPO shares: pay $ECON to the company treasury, receive shares from
    /// the sale vault (primary issuance). Reverts once the float is exhausted.
    pub fn buy_ipo(ctx: Context<BuyIpo>, shares: u64) -> Result<()> {
        require!(shares > 0, EquityError::ZeroShares);
        let co = &ctx.accounts.company;
        let sold = co.shares_sold.checked_add(shares).ok_or(EquityError::Overflow)?;
        require!(sold <= co.float_shares, EquityError::FloatExhausted);
        let cost = (shares as u128)
            .checked_mul(co.ipo_price_econ as u128)
            .ok_or(EquityError::Overflow)?;
        let cost = u64::try_from(cost).map_err(|_| error!(EquityError::Overflow))?;
        let founder = co.authority;
        let company_id = co.company_id;
        let bump = co.bump;

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.buyer_econ.to_account_info(),
                    to: ctx.accounts.treasury.to_account_info(),
                    authority: ctx.accounts.buyer.to_account_info(),
                },
            ),
            cost,
        )?;

        let seeds: &[&[u8]] = &[b"company", founder.as_ref(), company_id.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.sale_vault.to_account_info(),
                    to: ctx.accounts.buyer_shares.to_account_info(),
                    authority: ctx.accounts.company.to_account_info(),
                },
                &[seeds],
            ),
            shares,
        )?;
        ctx.accounts.company.shares_sold = sold;
        Ok(())
    }

    /// Release the escrowed founder shares to the company authority once the
    /// lockup has elapsed, then close the (now empty) escrow vault.
    pub fn unlock_founder(ctx: Context<UnlockFounder>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let co = &ctx.accounts.company;
        require!(!co.founder_released, EquityError::AlreadyReleased);
        require!(now >= co.founder_unlock_ts, EquityError::FounderLocked);

        let founder = co.authority;
        let company_id = co.company_id;
        let bump = co.bump;
        let seeds: &[&[u8]] = &[b"company", founder.as_ref(), company_id.as_ref(), &[bump]];
        let signer = &[seeds];
        let amount = ctx.accounts.founder_vault.amount;
        if amount > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.founder_vault.to_account_info(),
                        to: ctx.accounts.founder_shares.to_account_info(),
                        authority: ctx.accounts.company.to_account_info(),
                    },
                    signer,
                ),
                amount,
            )?;
        }
        token::close_account(CpiContext::new_with_signer(
            ctx.accounts.token_program.to_account_info(),
            CloseAccount {
                account: ctx.accounts.founder_vault.to_account_info(),
                destination: ctx.accounts.authority.to_account_info(),
                authority: ctx.accounts.company.to_account_info(),
            },
            signer,
        ))?;
        ctx.accounts.company.founder_released = true;
        Ok(())
    }
}

#[account]
#[derive(InitSpace)]
pub struct Config {
    /// The only signer allowed to `list_company`.
    pub authority: Pubkey,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct Company {
    pub company_id: [u8; 16],
    /// The founder: receives the escrowed shares and is a PDA seed.
    pub authority: Pubkey,
    pub share_mint: Pubkey,
    pub econ_mint: Pubkey,
    /// $ECON token account receiving IPO proceeds.
    pub treasury: Pubkey,
    /// Program-owned escrow holding founder shares until `founder_unlock_ts`.
    pub founder_vault: Pubkey,
    /// Program-owned vault holding the unsold public float.
    pub sale_vault: Pubkey,
    pub total_shares: u64,
    pub float_shares: u64,
    pub shares_sold: u64,
    pub ipo_price_econ: u64,
    pub founder_unlock_ts: i64,
    pub founder_released: bool,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitConfig<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    #[account(init, payer = payer, space = 8 + Config::INIT_SPACE, seeds = [b"config"], bump)]
    pub config: Account<'info, Config>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(company_id: [u8; 16])]
pub struct ListCompany<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(has_one = authority @ EquityError::Unauthorized, seeds = [b"config"], bump = config.bump)]
    pub config: Account<'info, Config>,
    /// CHECK: any wallet; becomes the company authority and a PDA seed.
    pub founder: UncheckedAccount<'info>,
    #[account(
        init, payer = authority, space = 8 + Company::INIT_SPACE,
        seeds = [b"company", founder.key().as_ref(), company_id.as_ref()], bump,
    )]
    pub company: Account<'info, Company>,
    #[account(init, payer = authority, mint::decimals = 0, mint::authority = company)]
    pub share_mint: Account<'info, Mint>,
    pub econ_mint: Account<'info, Mint>,
    #[account(token::mint = econ_mint)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(
        init, payer = authority,
        token::mint = share_mint, token::authority = company,
        seeds = [b"founder", company.key().as_ref()], bump,
    )]
    pub founder_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = authority,
        token::mint = share_mint, token::authority = company,
        seeds = [b"sale", company.key().as_ref()], bump,
    )]
    pub sale_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct BuyIpo<'info> {
    #[account(mut)]
    pub buyer: Signer<'info>,
    #[account(
        mut, has_one = treasury, has_one = sale_vault, has_one = share_mint,
        seeds = [b"company", company.authority.as_ref(), company.company_id.as_ref()], bump = company.bump,
    )]
    pub company: Account<'info, Company>,
    pub share_mint: Account<'info, Mint>,
    #[account(mut)]
    pub treasury: Account<'info, TokenAccount>,
    #[account(mut)]
    pub sale_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = company.econ_mint, token::authority = buyer)]
    pub buyer_econ: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = buyer,
        associated_token::mint = share_mint, associated_token::authority = buyer,
    )]
    pub buyer_shares: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct UnlockFounder<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    #[account(
        mut, has_one = authority, has_one = founder_vault, has_one = share_mint,
        seeds = [b"company", company.authority.as_ref(), company.company_id.as_ref()], bump = company.bump,
    )]
    pub company: Account<'info, Company>,
    pub share_mint: Account<'info, Mint>,
    #[account(mut)]
    pub founder_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = authority,
        associated_token::mint = share_mint, associated_token::authority = authority,
    )]
    pub founder_shares: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[error_code]
pub enum EquityError {
    #[msg("share count must be positive")]
    ZeroShares,
    #[msg("IPO price must be positive")]
    ZeroPrice,
    #[msg("float exceeds total shares")]
    BadFloat,
    #[msg("IPO float exhausted")]
    FloatExhausted,
    #[msg("founder shares still locked")]
    FounderLocked,
    #[msg("founder shares already released")]
    AlreadyReleased,
    #[msg("arithmetic overflow")]
    Overflow,
    #[msg("signer is not the protocol authority")]
    Unauthorized,
}
