//! Merkle-distributor dividends: the off-chain simulation computes each epoch's
//! per-holder payout, commits a Merkle root on-chain, and funds a vault.
//! Holders claim permissionlessly with a proof. This is the settlement bridge
//! between the fast off-chain economy and on-chain $ECON payouts.
//!
//! Leaf layout (must match `packages/integration/src/settlement.ts`):
//!   leaf = keccak256(epoch:u64le || index:u64le || claimant:32 || amount:u64le)
//! Internal nodes are keccak256 of the *sorted* pair.
//!
//! Each epoch gets its own `EpochRoot` account, so an epoch stays claimable
//! after the next one is published; once `expires_at` passes the admin may
//! `close_epoch` to sweep whatever was never claimed. A `ClaimReceipt` PDA per
//! (epoch, claimant) makes double claims impossible.

use anchor_lang::prelude::*;
use anchor_lang::solana_program::keccak;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("9pa4tHAX2LWdutZFRsKp74qJCYgh2ALZEKfvVteTev49");

#[program]
pub mod dividends {
    use super::*;

    /// Create the distributor for `mint`. `claim_window_secs` is how long each
    /// epoch stays claimable before the admin may sweep the remainder.
    pub fn init_distributor(ctx: Context<InitDistributor>, claim_window_secs: i64) -> Result<()> {
        require!(claim_window_secs > 0, DivError::BadClaimWindow);
        let d = &mut ctx.accounts.distributor;
        d.admin = ctx.accounts.admin.key();
        d.mint = ctx.accounts.mint.key();
        d.vault = ctx.accounts.vault.key();
        d.epoch = 0;
        d.claim_window_secs = claim_window_secs;
        d.bump = ctx.bumps.distributor;
        Ok(())
    }

    /// Publish the next epoch's root and fund the vault with its total payout.
    pub fn set_epoch_root(ctx: Context<SetEpochRoot>, epoch: u64, root: [u8; 32], total: u64) -> Result<()> {
        let d = &mut ctx.accounts.distributor;
        let next = d.epoch.checked_add(1).ok_or(DivError::Overflow)?;
        require!(epoch == next, DivError::BadEpoch);
        d.epoch = epoch;

        let now = Clock::get()?.unix_timestamp;
        let e = &mut ctx.accounts.epoch_root;
        e.distributor = d.key();
        e.epoch = epoch;
        e.root = root;
        e.total = total;
        e.claimed = 0;
        e.expires_at = now.checked_add(d.claim_window_secs).ok_or(DivError::Overflow)?;
        e.bump = ctx.bumps.epoch_root;

        if total > 0 {
            token::transfer(
                CpiContext::new(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.funder_ata.to_account_info(),
                        to: ctx.accounts.vault.to_account_info(),
                        authority: ctx.accounts.admin.to_account_info(),
                    },
                ),
                total,
            )?;
        }
        Ok(())
    }

    /// Claim `amount` for this epoch with a Merkle proof. The receipt PDA is
    /// created with `init`, so a second claim for the same (epoch, claimant)
    /// fails before any tokens move.
    pub fn claim(ctx: Context<Claim>, index: u64, amount: u64, proof: Vec<[u8; 32]>) -> Result<()> {
        let d = &ctx.accounts.distributor;
        let e = &mut ctx.accounts.epoch_root;

        let leaf = keccak::hashv(&[
            &e.epoch.to_le_bytes(),
            &index.to_le_bytes(),
            ctx.accounts.claimant.key().as_ref(),
            &amount.to_le_bytes(),
        ])
        .0;
        require!(verify(&proof, e.root, leaf), DivError::InvalidProof);

        let claimed = e.claimed.checked_add(amount).ok_or(DivError::Overflow)?;
        require!(claimed <= e.total, DivError::EpochOverdrawn);
        e.claimed = claimed;

        let r = &mut ctx.accounts.receipt;
        r.epoch = e.epoch;
        r.index = index;
        r.amount = amount;
        r.bump = ctx.bumps.receipt;

        let seeds: &[&[u8]] = &[b"distributor", d.mint.as_ref(), &[d.bump]];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.vault.to_account_info(),
                    to: ctx.accounts.claimant_ata.to_account_info(),
                    authority: ctx.accounts.distributor.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;
        Ok(())
    }

    /// After the claim window, sweep the unclaimed remainder to `destination`
    /// and close the epoch account (rent back to admin). Receipts stay, and the
    /// epoch account is gone, so nothing from this epoch can be claimed again.
    pub fn close_epoch(ctx: Context<CloseEpoch>) -> Result<()> {
        let d = &ctx.accounts.distributor;
        let e = &ctx.accounts.epoch_root;
        let now = Clock::get()?.unix_timestamp;
        require!(now >= e.expires_at, DivError::EpochNotExpired);

        let unclaimed = e.total.checked_sub(e.claimed).ok_or(DivError::Overflow)?;
        if unclaimed > 0 {
            let seeds: &[&[u8]] = &[b"distributor", d.mint.as_ref(), &[d.bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.vault.to_account_info(),
                        to: ctx.accounts.destination.to_account_info(),
                        authority: ctx.accounts.distributor.to_account_info(),
                    },
                    &[seeds],
                ),
                unclaimed,
            )?;
        }
        Ok(())
    }
}

fn verify(proof: &[[u8; 32]], root: [u8; 32], leaf: [u8; 32]) -> bool {
    let mut computed = leaf;
    for node in proof {
        computed = if computed <= *node {
            keccak::hashv(&[&computed, node]).0
        } else {
            keccak::hashv(&[node, &computed]).0
        };
    }
    computed == root
}

#[account]
#[derive(InitSpace)]
pub struct Distributor {
    pub admin: Pubkey,
    pub mint: Pubkey,
    pub vault: Pubkey,
    /// Latest published epoch (0 = none yet).
    pub epoch: u64,
    pub claim_window_secs: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct EpochRoot {
    pub distributor: Pubkey,
    pub epoch: u64,
    pub root: [u8; 32],
    /// Tokens funded for this epoch.
    pub total: u64,
    /// Tokens claimed so far; never exceeds `total`.
    pub claimed: u64,
    pub expires_at: i64,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct ClaimReceipt {
    pub epoch: u64,
    pub index: u64,
    pub amount: u64,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitDistributor<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub mint: Account<'info, Mint>,
    #[account(
        init, payer = admin, space = 8 + Distributor::INIT_SPACE,
        seeds = [b"distributor", mint.key().as_ref()], bump,
    )]
    pub distributor: Account<'info, Distributor>,
    #[account(
        init, payer = admin,
        token::mint = mint, token::authority = distributor,
        seeds = [b"vault", distributor.key().as_ref()], bump,
    )]
    pub vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
#[instruction(epoch: u64)]
pub struct SetEpochRoot<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        mut, has_one = admin, has_one = vault,
        seeds = [b"distributor", distributor.mint.as_ref()], bump = distributor.bump,
    )]
    pub distributor: Account<'info, Distributor>,
    #[account(
        init, payer = admin, space = 8 + EpochRoot::INIT_SPACE,
        seeds = [b"epoch", distributor.key().as_ref(), &epoch.to_le_bytes()], bump,
    )]
    pub epoch_root: Account<'info, EpochRoot>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = distributor.mint, token::authority = admin)]
    pub funder_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Claim<'info> {
    #[account(mut)]
    pub claimant: Signer<'info>,
    #[account(has_one = vault, seeds = [b"distributor", distributor.mint.as_ref()], bump = distributor.bump)]
    pub distributor: Account<'info, Distributor>,
    #[account(
        mut, has_one = distributor,
        seeds = [b"epoch", distributor.key().as_ref(), &epoch_root.epoch.to_le_bytes()], bump = epoch_root.bump,
    )]
    pub epoch_root: Account<'info, EpochRoot>,
    #[account(
        init, payer = claimant, space = 8 + ClaimReceipt::INIT_SPACE,
        seeds = [b"receipt", epoch_root.key().as_ref(), claimant.key().as_ref()], bump,
    )]
    pub receipt: Account<'info, ClaimReceipt>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = distributor.mint, token::authority = claimant)]
    pub claimant_ata: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct CloseEpoch<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    #[account(
        has_one = admin, has_one = vault,
        seeds = [b"distributor", distributor.mint.as_ref()], bump = distributor.bump,
    )]
    pub distributor: Account<'info, Distributor>,
    #[account(
        mut, close = admin, has_one = distributor,
        seeds = [b"epoch", distributor.key().as_ref(), &epoch_root.epoch.to_le_bytes()], bump = epoch_root.bump,
    )]
    pub epoch_root: Account<'info, EpochRoot>,
    #[account(mut)]
    pub vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = distributor.mint)]
    pub destination: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum DivError {
    #[msg("claim window must be positive")]
    BadClaimWindow,
    #[msg("epoch must increment by one")]
    BadEpoch,
    #[msg("invalid merkle proof")]
    InvalidProof,
    #[msg("claims would exceed the epoch's funded total")]
    EpochOverdrawn,
    #[msg("epoch claim window has not expired")]
    EpochNotExpired,
    #[msg("arithmetic overflow")]
    Overflow,
}
