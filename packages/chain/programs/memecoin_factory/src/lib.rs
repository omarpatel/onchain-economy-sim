//! Economy Sim in-game memecoin factory.
//!
//! Permissionless launch of player memecoins paired to $ECON, pump.fun style:
//! each coin trades on a constant-product bonding curve against $ECON until it
//! reaches a graduation threshold, at which point the mint authority is revoked,
//! unsold curve supply is burned and the accumulated $ECON reserve can be
//! moved by the factory authority to the protocol treasury / an AMM pool.
//!
//! Anti-rug rails baked in: mint authority revoked on graduation, curve-held
//! supply only (no creator pre-mint), creator + protocol fees can only ever land
//! in the creator's and protocol treasury's associated token accounts.

use anchor_lang::prelude::*;
use anchor_spl::associated_token::AssociatedToken;
use anchor_spl::token::{self, Burn, Mint, MintTo, SetAuthority, Token, TokenAccount, Transfer};

declare_id!("HgY4QYg5zVDLXD6rAi66HiX75rVgcUh7EN62Ua8T4DfG");

pub const TOKEN_DECIMALS: u8 = 6;
/// 1B tokens (6 decimals), all minted into the curve vault at creation.
pub const TOTAL_SUPPLY: u64 = 1_000_000_000 * 1_000_000;
/// Virtual reserves seed the curve so early buys aren't infinitely cheap.
pub const VIRTUAL_ECON: u128 = 30_000 * 1_000_000; // 30k virtual $ECON (6 decimals)
pub const VIRTUAL_TOKEN: u128 = 1_073_000_000 * 1_000_000;
/// The curve can absorb ~411k $ECON before the real supply is exhausted;
/// thresholds above this could never be reached.
pub const MAX_GRADUATION_ECON: u64 = 400_000 * 1_000_000;
pub const MAX_TOTAL_FEE_BPS: u16 = 1_000; // 10%
const BPS: u128 = 10_000;

#[program]
pub mod memecoin_factory {
    use super::*;

    /// One-time factory setup. `authority` may later withdraw graduated
    /// reserves; `protocol_treasury` is the wallet whose $ECON ATA receives
    /// protocol fees.
    pub fn init_factory(ctx: Context<InitFactory>, creator_fee_bps: u16, protocol_fee_bps: u16) -> Result<()> {
        let total = creator_fee_bps.checked_add(protocol_fee_bps).ok_or(FactoryError::Overflow)?;
        require!(total <= MAX_TOTAL_FEE_BPS, FactoryError::FeeTooHigh);
        let f = &mut ctx.accounts.factory;
        f.authority = ctx.accounts.authority.key();
        f.protocol_treasury = ctx.accounts.protocol_treasury.key();
        f.econ_mint = ctx.accounts.econ_mint.key();
        f.creator_fee_bps = creator_fee_bps;
        f.protocol_fee_bps = protocol_fee_bps;
        f.bump = ctx.bumps.factory;
        Ok(())
    }

    /// Launch a new memecoin. Full supply is minted to the curve vault; the
    /// creator gets zero pre-mint (anti-rug). Fee rates are snapshotted from
    /// the factory so later governance changes never affect live coins.
    pub fn create_coin(
        ctx: Context<CreateCoin>,
        name: String,
        symbol: String,
        graduate_threshold_econ: u64,
    ) -> Result<()> {
        require!(!name.is_empty() && name.len() <= 32, FactoryError::MetadataTooLong);
        require!(!symbol.is_empty() && symbol.len() <= 10, FactoryError::MetadataTooLong);
        require!(
            graduate_threshold_econ > 0 && graduate_threshold_econ <= MAX_GRADUATION_ECON,
            FactoryError::BadThreshold
        );

        let f = &ctx.accounts.factory;
        let cfg = &mut ctx.accounts.config;
        cfg.factory = f.key();
        cfg.creator = ctx.accounts.creator.key();
        cfg.mint = ctx.accounts.mint.key();
        cfg.econ_mint = f.econ_mint;
        cfg.curve_vault = ctx.accounts.curve_vault.key();
        cfg.econ_vault = ctx.accounts.econ_vault.key();
        cfg.name = name;
        cfg.symbol = symbol;
        cfg.virtual_econ = VIRTUAL_ECON;
        cfg.virtual_token = VIRTUAL_TOKEN;
        cfg.real_econ = 0;
        cfg.real_token_sold = 0;
        cfg.graduate_threshold_econ = graduate_threshold_econ;
        cfg.graduated = false;
        cfg.finalized = false;
        cfg.creator_fee_bps = f.creator_fee_bps;
        cfg.protocol_fee_bps = f.protocol_fee_bps;
        cfg.bump = ctx.bumps.config;
        let mint = cfg.mint;
        let bump = cfg.bump;

        let seeds: &[&[u8]] = &[b"config", mint.as_ref(), &[bump]];
        token::mint_to(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                MintTo {
                    mint: ctx.accounts.mint.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            TOTAL_SUPPLY,
        )?;
        Ok(())
    }

    /// Buy coin with `econ_in` $ECON along the bonding curve. Fees come off
    /// the top; the net amount enters the curve.
    pub fn buy(ctx: Context<Trade>, econ_in: u64, min_tokens_out: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.graduated, FactoryError::AlreadyGraduated);

        let (creator_fee, protocol_fee) = cfg.fees(econ_in)?;
        let net = econ_in
            .checked_sub(creator_fee)
            .and_then(|v| v.checked_sub(protocol_fee))
            .ok_or(FactoryError::Overflow)?;
        require!(net > 0, FactoryError::ZeroAmount);

        let (econ_r, token_r, k) = cfg.reserves()?;
        let new_econ = econ_r.checked_add(net as u128).ok_or(FactoryError::Overflow)?;
        let new_token = div_ceil(k, new_econ)?;
        let tokens_out = token_r.checked_sub(new_token).ok_or(FactoryError::Overflow)?;
        let tokens_out = u64::try_from(tokens_out).map_err(|_| error!(FactoryError::Overflow))?;
        require!(tokens_out > 0 && tokens_out >= min_tokens_out, FactoryError::SlippageExceeded);
        let mint = cfg.mint;
        let bump = cfg.bump;

        // Pull $ECON from buyer: net -> curve econ vault, fees -> creator/protocol ATAs.
        token::transfer(ctx.accounts.econ_from_user(ctx.accounts.econ_vault.to_account_info()), net)?;
        if creator_fee > 0 {
            token::transfer(ctx.accounts.econ_from_user(ctx.accounts.creator_fee_ata.to_account_info()), creator_fee)?;
        }
        if protocol_fee > 0 {
            token::transfer(ctx.accounts.econ_from_user(ctx.accounts.protocol_fee_ata.to_account_info()), protocol_fee)?;
        }

        // Send tokens from curve vault to buyer.
        let seeds: &[&[u8]] = &[b"config", mint.as_ref(), &[bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.curve_vault.to_account_info(),
                    to: ctx.accounts.user_token_ata.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            tokens_out,
        )?;

        let cfg = &mut ctx.accounts.config;
        cfg.real_econ = cfg.real_econ.checked_add(net).ok_or(FactoryError::Overflow)?;
        cfg.real_token_sold = cfg.real_token_sold.checked_add(tokens_out).ok_or(FactoryError::Overflow)?;
        if cfg.real_econ >= cfg.graduate_threshold_econ {
            cfg.graduated = true;
            emit!(Graduated { mint: cfg.mint, econ_reserve: cfg.real_econ });
        }
        Ok(())
    }

    /// Sell `tokens_in` back to the curve for $ECON (fees split off the gross).
    pub fn sell(ctx: Context<Trade>, tokens_in: u64, min_econ_out: u64) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(!cfg.graduated, FactoryError::AlreadyGraduated);
        require!(tokens_in > 0, FactoryError::ZeroAmount);

        let (econ_r, token_r, k) = cfg.reserves()?;
        let new_token = token_r.checked_add(tokens_in as u128).ok_or(FactoryError::Overflow)?;
        let new_econ = div_ceil(k, new_token)?;
        let gross = econ_r.checked_sub(new_econ).ok_or(FactoryError::Overflow)?;
        let gross = u64::try_from(gross).map_err(|_| error!(FactoryError::Overflow))?;
        // Rounding can never let the curve pay out more real $ECON than it holds.
        let gross = gross.min(cfg.real_econ);
        let (creator_fee, protocol_fee) = cfg.fees(gross)?;
        let econ_out = gross
            .checked_sub(creator_fee)
            .and_then(|v| v.checked_sub(protocol_fee))
            .ok_or(FactoryError::Overflow)?;
        require!(econ_out > 0 && econ_out >= min_econ_out, FactoryError::SlippageExceeded);
        let mint = cfg.mint;
        let bump = cfg.bump;

        // Seller returns tokens to the curve vault.
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_token_ata.to_account_info(),
                    to: ctx.accounts.curve_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            tokens_in,
        )?;

        // Pay $ECON out of the curve vault, fees split off first.
        let seeds: &[&[u8]] = &[b"config", mint.as_ref(), &[bump]];
        let signer = &[seeds];
        token::transfer(ctx.accounts.econ_from_vault(ctx.accounts.user_econ_ata.to_account_info(), signer), econ_out)?;
        if creator_fee > 0 {
            token::transfer(ctx.accounts.econ_from_vault(ctx.accounts.creator_fee_ata.to_account_info(), signer), creator_fee)?;
        }
        if protocol_fee > 0 {
            token::transfer(ctx.accounts.econ_from_vault(ctx.accounts.protocol_fee_ata.to_account_info(), signer), protocol_fee)?;
        }

        let cfg = &mut ctx.accounts.config;
        cfg.real_econ = cfg.real_econ.checked_sub(gross).ok_or(FactoryError::Overflow)?;
        cfg.real_token_sold = cfg.real_token_sold.checked_sub(tokens_in).ok_or(FactoryError::Overflow)?;
        Ok(())
    }

    /// Permissionless graduation finalize: revoke mint authority and burn any
    /// unsold curve tokens so the float is fixed.
    pub fn finalize_graduation(ctx: Context<Finalize>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(cfg.graduated, FactoryError::NotGraduated);
        require!(!cfg.finalized, FactoryError::AlreadyFinalized);
        let mint = cfg.mint;
        let bump = cfg.bump;
        let seeds: &[&[u8]] = &[b"config", mint.as_ref(), &[bump]];

        token::set_authority(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                SetAuthority {
                    current_authority: ctx.accounts.config.to_account_info(),
                    account_or_mint: ctx.accounts.mint.to_account_info(),
                },
                &[seeds],
            ),
            token::spl_token::instruction::AuthorityType::MintTokens,
            None,
        )?;

        let leftover = ctx.accounts.curve_vault.amount;
        if leftover > 0 {
            token::burn(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Burn {
                        mint: ctx.accounts.mint.to_account_info(),
                        from: ctx.accounts.curve_vault.to_account_info(),
                        authority: ctx.accounts.config.to_account_info(),
                    },
                    &[seeds],
                ),
                leftover,
            )?;
        }
        ctx.accounts.config.finalized = true;
        Ok(())
    }

    /// Factory authority moves a finalized coin's $ECON reserve out of the
    /// curve (to the protocol treasury or an AMM pool for LP migration).
    pub fn withdraw_graduated(ctx: Context<WithdrawGraduated>) -> Result<()> {
        let cfg = &ctx.accounts.config;
        require!(cfg.finalized, FactoryError::NotGraduated);
        let amount = ctx.accounts.econ_vault.amount;
        require!(amount > 0, FactoryError::ZeroAmount);
        let seeds: &[&[u8]] = &[b"config", cfg.mint.as_ref(), &[cfg.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.econ_vault.to_account_info(),
                    to: ctx.accounts.destination.to_account_info(),
                    authority: ctx.accounts.config.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }
}

fn div_ceil(a: u128, b: u128) -> Result<u128> {
    require!(b > 0, FactoryError::Overflow);
    let q = a / b;
    Ok(if a % b == 0 { q } else { q.checked_add(1).ok_or(FactoryError::Overflow)? })
}

#[account]
#[derive(InitSpace)]
pub struct Factory {
    pub authority: Pubkey,
    pub protocol_treasury: Pubkey,
    pub econ_mint: Pubkey,
    pub creator_fee_bps: u16,
    pub protocol_fee_bps: u16,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct CoinConfig {
    pub factory: Pubkey,
    pub creator: Pubkey,
    pub mint: Pubkey,
    pub econ_mint: Pubkey,
    pub curve_vault: Pubkey,
    pub econ_vault: Pubkey,
    #[max_len(32)]
    pub name: String,
    #[max_len(10)]
    pub symbol: String,
    pub virtual_econ: u128,
    pub virtual_token: u128,
    pub real_econ: u64,
    pub real_token_sold: u64,
    pub graduate_threshold_econ: u64,
    pub graduated: bool,
    pub finalized: bool,
    pub creator_fee_bps: u16,
    pub protocol_fee_bps: u16,
    pub bump: u8,
}

impl CoinConfig {
    fn fees(&self, amount: u64) -> Result<(u64, u64)> {
        let c = (amount as u128).checked_mul(self.creator_fee_bps as u128).ok_or(FactoryError::Overflow)? / BPS;
        let p = (amount as u128).checked_mul(self.protocol_fee_bps as u128).ok_or(FactoryError::Overflow)? / BPS;
        Ok((c as u64, p as u64))
    }

    /// (econ reserve, token reserve, k) including virtual liquidity.
    fn reserves(&self) -> Result<(u128, u128, u128)> {
        let econ_r = self.virtual_econ.checked_add(self.real_econ as u128).ok_or(FactoryError::Overflow)?;
        let token_r = self.virtual_token.checked_sub(self.real_token_sold as u128).ok_or(FactoryError::Overflow)?;
        let k = econ_r.checked_mul(token_r).ok_or(FactoryError::Overflow)?;
        Ok((econ_r, token_r, k))
    }
}

#[event]
pub struct Graduated {
    pub mint: Pubkey,
    pub econ_reserve: u64,
}

#[derive(Accounts)]
pub struct InitFactory<'info> {
    #[account(mut)]
    pub authority: Signer<'info>,
    /// CHECK: any wallet; its $ECON ATA (created here) receives protocol fees.
    pub protocol_treasury: UncheckedAccount<'info>,
    pub econ_mint: Account<'info, Mint>,
    #[account(init, payer = authority, space = 8 + Factory::INIT_SPACE, seeds = [b"factory"], bump)]
    pub factory: Account<'info, Factory>,
    #[account(
        init_if_needed, payer = authority,
        associated_token::mint = econ_mint, associated_token::authority = protocol_treasury,
    )]
    pub protocol_fee_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CreateCoin<'info> {
    #[account(mut)]
    pub creator: Signer<'info>,
    #[account(has_one = econ_mint, seeds = [b"factory"], bump = factory.bump)]
    pub factory: Account<'info, Factory>,
    pub econ_mint: Account<'info, Mint>,
    #[account(init, payer = creator, mint::decimals = TOKEN_DECIMALS, mint::authority = config)]
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = creator, space = 8 + CoinConfig::INIT_SPACE,
        seeds = [b"config", mint.key().as_ref()], bump,
    )]
    pub config: Account<'info, CoinConfig>,
    #[account(
        init, payer = creator, token::mint = mint, token::authority = config,
        seeds = [b"curve", mint.key().as_ref()], bump,
    )]
    pub curve_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = creator, token::mint = econ_mint, token::authority = config,
        seeds = [b"econ", mint.key().as_ref()], bump,
    )]
    pub econ_vault: Account<'info, TokenAccount>,
    /// The creator's $ECON ATA must exist so trades can always pay fees.
    #[account(
        init_if_needed, payer = creator,
        associated_token::mint = econ_mint, associated_token::authority = creator,
    )]
    pub creator_fee_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Trade<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(has_one = protocol_treasury, has_one = econ_mint, seeds = [b"factory"], bump = factory.bump)]
    pub factory: Account<'info, Factory>,
    #[account(
        mut, has_one = factory, has_one = creator, has_one = mint, has_one = curve_vault, has_one = econ_vault,
        seeds = [b"config", config.mint.as_ref()], bump = config.bump,
    )]
    pub config: Account<'info, CoinConfig>,
    pub mint: Account<'info, Mint>,
    pub econ_mint: Account<'info, Mint>,
    #[account(mut)]
    pub curve_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub econ_vault: Account<'info, TokenAccount>,
    #[account(
        init_if_needed, payer = user,
        associated_token::mint = mint, associated_token::authority = user,
    )]
    pub user_token_ata: Account<'info, TokenAccount>,
    #[account(mut, token::mint = econ_mint, token::authority = user)]
    pub user_econ_ata: Account<'info, TokenAccount>,
    /// CHECK: enforced equal to `config.creator` by `has_one`.
    pub creator: UncheckedAccount<'info>,
    /// CHECK: enforced equal to `factory.protocol_treasury` by `has_one`.
    pub protocol_treasury: UncheckedAccount<'info>,
    #[account(mut, associated_token::mint = econ_mint, associated_token::authority = creator)]
    pub creator_fee_ata: Account<'info, TokenAccount>,
    #[account(mut, associated_token::mint = econ_mint, associated_token::authority = protocol_treasury)]
    pub protocol_fee_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

impl<'info> Trade<'info> {
    fn econ_from_user(&self, to: AccountInfo<'info>) -> CpiContext<'_, '_, '_, 'info, Transfer<'info>> {
        CpiContext::new(
            self.token_program.to_account_info(),
            Transfer { from: self.user_econ_ata.to_account_info(), to, authority: self.user.to_account_info() },
        )
    }
    fn econ_from_vault<'a>(
        &'a self, to: AccountInfo<'info>, signer: &'a [&'a [&'a [u8]]],
    ) -> CpiContext<'a, 'a, 'a, 'info, Transfer<'info>> {
        CpiContext::new_with_signer(
            self.token_program.to_account_info(),
            Transfer { from: self.econ_vault.to_account_info(), to, authority: self.config.to_account_info() },
            signer,
        )
    }
}

#[derive(Accounts)]
pub struct Finalize<'info> {
    #[account(mut, has_one = mint, has_one = curve_vault, seeds = [b"config", config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, CoinConfig>,
    #[account(mut)]
    pub mint: Account<'info, Mint>,
    #[account(mut)]
    pub curve_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct WithdrawGraduated<'info> {
    pub authority: Signer<'info>,
    #[account(has_one = authority, seeds = [b"factory"], bump = factory.bump)]
    pub factory: Account<'info, Factory>,
    #[account(has_one = factory, has_one = econ_vault, seeds = [b"config", config.mint.as_ref()], bump = config.bump)]
    pub config: Account<'info, CoinConfig>,
    #[account(mut)]
    pub econ_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = factory.econ_mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum FactoryError {
    #[msg("name must be 1-32 bytes and symbol 1-10 bytes")]
    MetadataTooLong,
    #[msg("graduation threshold out of range")]
    BadThreshold,
    #[msg("combined fees exceed 10%")]
    FeeTooHigh,
    #[msg("amount must be positive")]
    ZeroAmount,
    #[msg("coin already graduated")]
    AlreadyGraduated,
    #[msg("coin has not graduated")]
    NotGraduated,
    #[msg("graduation already finalized")]
    AlreadyFinalized,
    #[msg("slippage exceeded")]
    SlippageExceeded,
    #[msg("arithmetic overflow")]
    Overflow,
}
