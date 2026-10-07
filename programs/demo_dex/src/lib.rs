//! Local test exchange: 100 testUSDC (6 decimals) buys 1 testSOL (9 decimals).

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{self, Mint, Token, TokenAccount, Transfer},
};

declare_id!("BWsLwF3o7fzMmtGwp1qA2fC4sSTYt4BjzKQXCXHoEyNz");

pub const RATE_MULTIPLIER: u64 = 10;

#[program]
pub mod demo_dex {
    use super::*;

    pub fn initialize_pool(ctx: Context<InitializePool>) -> Result<()> {
        ctx.accounts.pool.set_inner(Pool {
            input_mint: ctx.accounts.input_mint.key(),
            output_mint: ctx.accounts.output_mint.key(),
            input_reserve: ctx.accounts.input_reserve.key(),
            output_reserve: ctx.accounts.output_reserve.key(),
            bump: ctx.bumps.pool,
            authority_bump: ctx.bumps.pool_authority,
        });
        Ok(())
    }

    pub fn swap(ctx: Context<Swap>, amount_in: u64) -> Result<()> {
        require!(amount_in > 0, DemoDexError::InvalidAmount);
        let amount_out = amount_in
            .checked_mul(RATE_MULTIPLIER)
            .ok_or(DemoDexError::InvalidAmount)?;
        require!(
            ctx.accounts.output_reserve.amount >= amount_out,
            DemoDexError::InsufficientReserve
        );

        token::transfer(
            CpiContext::new(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.user_input.to_account_info(),
                    to: ctx.accounts.input_reserve.to_account_info(),
                    authority: ctx.accounts.user_authority.to_account_info(),
                },
            ),
            amount_in,
        )?;

        let pool_key = ctx.accounts.pool.key();
        let authority_bump = [ctx.accounts.pool.authority_bump];
        let seeds = &[
            b"pool-authority".as_ref(),
            pool_key.as_ref(),
            &authority_bump,
        ];
        token::transfer(
            CpiContext::new_with_signer(
                ctx.accounts.token_program.key(),
                Transfer {
                    from: ctx.accounts.output_reserve.to_account_info(),
                    to: ctx.accounts.user_output.to_account_info(),
                    authority: ctx.accounts.pool_authority.to_account_info(),
                },
                &[seeds],
            ),
            amount_out,
        )
    }
}

#[derive(Accounts)]
pub struct InitializePool<'info> {
    #[account(mut)]
    pub payer: Signer<'info>,
    pub input_mint: Account<'info, Mint>,
    pub output_mint: Account<'info, Mint>,
    #[account(
        init,
        payer = payer,
        space = 8 + Pool::INIT_SPACE,
        seeds = [b"pool", input_mint.key().as_ref(), output_mint.key().as_ref()],
        bump,
        constraint = input_mint.key() != output_mint.key() @ DemoDexError::AccountMismatch
    )]
    pub pool: Account<'info, Pool>,
    /// CHECK: This PDA is used only as a token authority; its seeds are checked here.
    #[account(seeds = [b"pool-authority", pool.key().as_ref()], bump)]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = input_mint,
        associated_token::authority = pool_authority
    )]
    pub input_reserve: Account<'info, TokenAccount>,
    #[account(
        init,
        payer = payer,
        associated_token::mint = output_mint,
        associated_token::authority = pool_authority
    )]
    pub output_reserve: Account<'info, TokenAccount>,
    pub token_program: Program<'info, Token>,
    pub associated_token_program: Program<'info, AssociatedToken>,
    pub system_program: Program<'info, System>,
}

#[derive(Accounts)]
pub struct Swap<'info> {
    pub user_authority: Signer<'info>,
    #[account(
        seeds = [b"pool", pool.input_mint.as_ref(), pool.output_mint.as_ref()],
        bump = pool.bump,
        has_one = input_reserve @ DemoDexError::AccountMismatch,
        has_one = output_reserve @ DemoDexError::AccountMismatch
    )]
    pub pool: Box<Account<'info, Pool>>,
    /// CHECK: Used only as the transfer authority; seeds and stored bump are checked.
    #[account(
        seeds = [b"pool-authority", pool.key().as_ref()],
        bump = pool.authority_bump
    )]
    pub pool_authority: UncheckedAccount<'info>,
    #[account(
        mut,
        constraint = user_input.mint == pool.input_mint @ DemoDexError::AccountMismatch,
        constraint = user_input.owner == user_authority.key() @ DemoDexError::AccountMismatch
    )]
    pub user_input: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = user_output.mint == pool.output_mint @ DemoDexError::AccountMismatch
    )]
    pub user_output: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = input_reserve.mint == pool.input_mint @ DemoDexError::AccountMismatch,
        constraint = input_reserve.owner == pool_authority.key() @ DemoDexError::AccountMismatch
    )]
    pub input_reserve: Box<Account<'info, TokenAccount>>,
    #[account(
        mut,
        constraint = output_reserve.mint == pool.output_mint @ DemoDexError::AccountMismatch,
        constraint = output_reserve.owner == pool_authority.key() @ DemoDexError::AccountMismatch
    )]
    pub output_reserve: Box<Account<'info, TokenAccount>>,
    pub token_program: Program<'info, Token>,
}

#[account]
#[derive(InitSpace)]
pub struct Pool {
    pub input_mint: Pubkey,
    pub output_mint: Pubkey,
    pub input_reserve: Pubkey,
    pub output_reserve: Pubkey,
    pub bump: u8,
    pub authority_bump: u8,
}

#[error_code]
pub enum DemoDexError {
    #[msg("The amount is zero or overflows the fixed exchange rate")]
    InvalidAmount,
    #[msg("The pool has insufficient output reserves")]
    InsufficientReserve,
    #[msg("An account does not match the required mint, pool, authority, or reserve")]
    AccountMismatch,
}
