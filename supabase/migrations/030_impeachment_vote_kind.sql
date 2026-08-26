-- Add impeachment vote kind to state_votes.vote_kind check constraint.
-- Must be applied after migration 016 which created the original constraint.

alter table public.state_votes
  drop constraint state_votes_vote_kind_check;

alter table public.state_votes
  add constraint state_votes_vote_kind_check
  check (vote_kind in ('war','alliance','impeachment'));
