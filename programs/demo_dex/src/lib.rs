//! P1 interface scaffold. Exchange logic and remaining checks are added in P3.

use anchor_lang::prelude::*;
use anchor_spl::{
    associated_token::AssociatedToken,
    token::{Mint, Token, TokenAccount},
};

declare_id!("BWsLwF3o7fzMmtGwp1qA2fC4sSTYt4BjzKQXCXHoEyNz");

#[program]
pub mod demo_dex {
    use super::*;

    pub fn initialize_pool(_ctx: Context<InitializePool>) -> Result<()> {
        Ok(())
    }

    pub fn swap(_ctx: Context<Swap>, amount_in: u64) -> Result<()> {
        let _ = amount_in;
        Ok(())
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
        bump
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
    pub pool: Account<'info, Pool>,
    /// CHECK: Unused by the P1 stub. P3 validates this PDA before signing transfers.
    pub pool_authority: UncheckedAccount<'info>,
    #[account(mut)]
    pub user_input: Account<'info, TokenAccount>,
    #[account(mut)]
    pub user_output: Account<'info, TokenAccount>,
    #[account(mut)]
    pub input_reserve: Account<'info, TokenAccount>,
    #[account(mut)]
    pub output_reserve: Account<'info, TokenAccount>,
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
