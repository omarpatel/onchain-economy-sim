//! veECON staking: lock $ECON for a boost weight + real-yield share.
//!
//! Longer locks grant a larger boost (used by the game to multiply a staked
//! company's production) and a larger share of distributed protocol fee revenue
//! (real yield, funded by pump.fun creator fees + marketplace fees).
//!
//! Rewards use the MasterChef accumulator: `acc_reward_per_weight` grows on
//! every `distribute`; a position's pending rewards are
//! `weight * acc / PRECISION - reward_debt`. Re-staking merges into the existing
//! position: the lock end becomes `max(old, now + lock_secs)` and the boost is
//! recomputed from the remaining lock for the whole merged amount, so a top-up
//! can never shorten a lock or dilute a longer boost.

use anchor_lang::prelude::*;
use anchor_spl::token::{self, Mint, Token, TokenAccount, Transfer};

declare_id!("5UY85ZT5N9orriVVrWDgqkBWa49soX1iNKuLRh8d71AZ");

const ACC_PRECISION: u128 = 1_000_000_000_000;
/// 4 years -> max boost (2x weight).
pub const MAX_LOCK: i64 = 4 * 365 * 24 * 3600;
const BPS: u64 = 10_000;
/// 1 $ECON (6 decimals). Bounds `acc_reward_per_weight` so `weight * acc`
/// can never overflow u128 even if the entire supply is distributed at once.
pub const MIN_STAKE: u64 = 1_000_000;

#[program]
pub mod staking {
    use super::*;

    pub fn init_pool(ctx: Context<InitPool>) -> Result<()> {
        let p = &mut ctx.accounts.pool;
        p.econ_mint = ctx.accounts.econ_mint.key();
        p.stake_vault = ctx.accounts.stake_vault.key();
        p.reward_vault = ctx.accounts.reward_vault.key();
        p.total_weight = 0;
        p.acc_reward_per_weight = 0;
        p.bump = ctx.bumps.pool;
        Ok(())
    }

    /// Fund the reward vault and update the global reward index (real yield in).
    pub fn distribute(ctx: Context<Distribute>, amount: u64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        let p = &mut ctx.accounts.pool;
        require!(p.total_weight > 0, StakeError::NoStakers);
        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.payer_econ.to_account_info(),
                    to: ctx.accounts.reward_vault.to_account_info(),
                    authority: ctx.accounts.payer.to_account_info(),
                },
            ),
            amount,
        )?;
        let delta = (amount as u128)
            .checked_mul(ACC_PRECISION)
            .ok_or(StakeError::Overflow)?
            .checked_div(p.total_weight as u128)
            .ok_or(StakeError::Overflow)?;
        p.acc_reward_per_weight = p.acc_reward_per_weight.checked_add(delta).ok_or(StakeError::Overflow)?;
        Ok(())
    }

    /// Lock `amount` of $ECON for `lock_secs`. Merges into an existing
    /// position (see module docs); pending rewards are settled first.
    pub fn stake(ctx: Context<Stake>, amount: u64, lock_secs: i64) -> Result<()> {
        require!(amount > 0, StakeError::ZeroAmount);
        require!(amount >= MIN_STAKE, StakeError::BelowMinStake);
        require!(lock_secs > 0 && lock_secs <= MAX_LOCK, StakeError::BadLock);
        let now = Clock::get()?.unix_timestamp;
        let p = &mut ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;

        if pos.amount > 0 {
            let pending = pending_rewards(pos, p)?;
            pos.unclaimed = pos.unclaimed.checked_add(pending).ok_or(StakeError::Overflow)?;
        } else {
            pos.owner = ctx.accounts.user.key();
            pos.pool = p.key();
            pos.lock_until = 0;
            pos.unclaimed = 0;
            pos.bump = ctx.bumps.position;
        }

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.user_econ.to_account_info(),
                    to: ctx.accounts.stake_vault.to_account_info(),
                    authority: ctx.accounts.user.to_account_info(),
                },
            ),
            amount,
        )?;

        let new_amount = pos.amount.checked_add(amount).ok_or(StakeError::Overflow)?;
        let requested_until = now.checked_add(lock_secs).ok_or(StakeError::Overflow)?;
        let lock_until = pos.lock_until.max(requested_until);
        let remaining = lock_until - now; // in (0, MAX_LOCK]
        let boost_bps = boost_bps_for(remaining)?;
        let new_weight = weight_for(new_amount, boost_bps)?;

        p.total_weight = p
            .total_weight
            .checked_sub(pos.weight)
            .ok_or(StakeError::Overflow)?
            .checked_add(new_weight)
            .ok_or(StakeError::Overflow)?;

        pos.amount = new_amount;
        pos.weight = new_weight;
        pos.lock_until = lock_until;
        pos.boost_bps = boost_bps;
        pos.reward_debt = reward_debt_for(new_weight, p.acc_reward_per_weight)?;
        Ok(())
    }

    /// Pay out all accrued rewards without touching the principal.
    pub fn claim(ctx: Context<ClaimRewards>) -> Result<()> {
        let p = &ctx.accounts.pool;
        let pos = &mut ctx.accounts.position;
        let owed = settle(pos, p)?;
        if owed > 0 {
            let seeds: &[&[u8]] = &[b"pool", p.econ_mint.as_ref(), &[p.bump]];
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.reward_vault.to_account_info(),
                        to: ctx.accounts.user_econ.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                owed,
            )?;
        }
        Ok(())
    }

    /// After the lock ends: pay accrued rewards, return the principal and close
    /// the position (rent back to the user).
    pub fn unstake(ctx: Context<Unstake>) -> Result<()> {
        let now = Clock::get()?.unix_timestamp;
        let pos = &mut ctx.accounts.position;
        require!(pos.amount > 0, StakeError::ZeroAmount);
        require!(now >= pos.lock_until, StakeError::StillLocked);

        let owed = settle(pos, &ctx.accounts.pool)?;
        let amount = pos.amount;
        let weight = pos.weight;
        let econ_mint = ctx.accounts.pool.econ_mint;
        let seeds: &[&[u8]] = &[b"pool", econ_mint.as_ref(), &[ctx.accounts.pool.bump]];

        if owed > 0 {
            token::transfer(
                CpiContext::new_with_signer(
                    ctx.accounts.token_program.to_account_info(),
                    Transfer {
                        from: ctx.accounts.reward_vault.to_account_info(),
                        to: ctx.accounts.user_econ.to_account_info(),
                        authority: ctx.accounts.pool.to_account_info(),
                    },
                    &[seeds],
                ),
                owed,
            )?;
        }
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.to_account_info(),
                Transfer {
                    from: ctx.accounts.stake_vault.to_account_info(),
                    to: ctx.accounts.user_econ.to_account_info(),
                    authority: ctx.accounts.pool.to_account_info(),
                },
                &[seeds],
            ),
            amount,
        )?;

        let p = &mut ctx.accounts.pool;
        p.total_weight = p.total_weight.checked_sub(weight).ok_or(StakeError::Overflow)?;
        pos.amount = 0;
        pos.weight = 0;
        pos.reward_debt = 0;
        Ok(())
    }
}

/// weight = amount * (1 + lock/MAX_LOCK) -> up to 2x for a max lock.
fn boost_bps_for(lock_remaining: i64) -> Result<u64> {
    let extra = (lock_remaining as u128)
        .checked_mul(BPS as u128)
        .ok_or(StakeError::Overflow)?
        / MAX_LOCK as u128;
    Ok(BPS + extra as u64)
}

fn weight_for(amount: u64, boost_bps: u64) -> Result<u64> {
    let w = (amount as u128).checked_mul(boost_bps as u128).ok_or(StakeError::Overflow)? / BPS as u128;
    u64::try_from(w).map_err(|_| error!(StakeError::Overflow))
}

fn reward_debt_for(weight: u64, acc: u128) -> Result<u128> {
    Ok((weight as u128).checked_mul(acc).ok_or(StakeError::Overflow)? / ACC_PRECISION)
}

fn pending_rewards(pos: &StakePosition, p: &StakePool) -> Result<u128> {
    let accrued = reward_debt_for(pos.weight, p.acc_reward_per_weight)?;
    Ok(accrued.saturating_sub(pos.reward_debt))
}

/// Move everything the position is owed into a single u64 payout and reset
/// the accounting so it cannot be paid twice.
fn settle(pos: &mut StakePosition, p: &StakePool) -> Result<u64> {
    let owed = pending_rewards(pos, p)?.checked_add(pos.unclaimed).ok_or(StakeError::Overflow)?;
    pos.unclaimed = 0;
    pos.reward_debt = reward_debt_for(pos.weight, p.acc_reward_per_weight)?;
    u64::try_from(owed).map_err(|_| error!(StakeError::Overflow))
}

#[account]
#[derive(InitSpace)]
pub struct StakePool {
    pub econ_mint: Pubkey,
    pub stake_vault: Pubkey,
    pub reward_vault: Pubkey,
    pub total_weight: u64,
    pub acc_reward_per_weight: u128,
    pub bump: u8,
}

#[account]
#[derive(InitSpace)]
pub struct StakePosition {
    pub owner: Pubkey,
    pub pool: Pubkey,
    pub amount: u64,
    pub weight: u64,
    pub lock_until: i64,
    pub boost_bps: u64,
    pub reward_debt: u128,
    pub unclaimed: u128,
    pub bump: u8,
}

#[derive(Accounts)]
pub struct InitPool<'info> {
    #[account(mut)]
    pub admin: Signer<'info>,
    pub econ_mint: Account<'info, Mint>,
    #[account(
        init, payer = admin, space = 8 + StakePool::INIT_SPACE,
        seeds = [b"pool", econ_mint.key().as_ref()], bump,
    )]
    pub pool: Account<'info, StakePool>,
    #[account(
        init, payer = admin, token::mint = econ_mint, token::authority = pool,
        seeds = [b"stake", pool.key().as_ref()], bump,
    )]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(
        init, payer = admin, token::mint = econ_mint, token::authority = pool,
        seeds = [b"reward", pool.key().as_ref()], bump,
    )]
    pub reward_vault: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Distribute<'info> {
    pub payer: Signer<'info>,
    #[account(mut, has_one = reward_vault, seeds = [b"pool", pool.econ_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, StakePool>,
    #[account(mut)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.econ_mint, token::authority = payer)]
    pub payer_econ: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Stake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(mut, has_one = stake_vault, seeds = [b"pool", pool.econ_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, StakePool>,
    #[account(
        init_if_needed, payer = user, space = 8 + StakePosition::INIT_SPACE,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()], bump,
    )]
    pub position: Account<'info, StakePosition>,
    #[account(mut)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.econ_mint, token::authority = user)]
    pub user_econ: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct ClaimRewards<'info> {
    pub user: Signer<'info>,
    #[account(has_one = reward_vault, seeds = [b"pool", pool.econ_mint.as_ref()], bump = pool.bump)]
    pub pool: Account<'info, StakePool>,
    #[account(
        mut, constraint = position.owner == user.key() @ StakeError::NotOwner,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()], bump = position.bump,
    )]
    pub position: Account<'info, StakePosition>,
    #[account(mut)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.econ_mint, token::authority = user)]
    pub user_econ: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[derive(Accounts)]
pub struct Unstake<'info> {
    #[account(mut)]
    pub user: Signer<'info>,
    #[account(
        mut, has_one = stake_vault, has_one = reward_vault,
        seeds = [b"pool", pool.econ_mint.as_ref()], bump = pool.bump,
    )]
    pub pool: Account<'info, StakePool>,
    #[account(
        mut, close = user, constraint = position.owner == user.key() @ StakeError::NotOwner,
        seeds = [b"position", pool.key().as_ref(), user.key().as_ref()], bump = position.bump,
    )]
    pub position: Account<'info, StakePosition>,
    #[account(mut)]
    pub stake_vault: Account<'info, TokenAccount>,
    #[account(mut)]
    pub reward_vault: Account<'info, TokenAccount>,
    #[account(mut, token::mint = pool.econ_mint, token::authority = user)]
    pub user_econ: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
}

#[error_code]
pub enum StakeError {
    #[msg("amount must be positive")]
    ZeroAmount,
    #[msg("stake below the 1 $ECON minimum")]
    BelowMinStake,
    #[msg("lock duration out of range")]
    BadLock,
    #[msg("no stakers in pool")]
    NoStakers,
    #[msg("stake still locked")]
    StillLocked,
    #[msg("position is not owned by signer")]
    NotOwner,
    #[msg("arithmetic overflow")]
    Overflow,
}
