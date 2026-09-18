/**
 * Reasonix's two axes, and how Grimoire's one toolbar drives both.
 *
 * A session carries a *mode* — `normal`, `plan`, `goal`, listed under `modes`
 * in the `session/new` reply — and, separately, a `tool_approval` config option
 * whose legacy values are `ask`, `auto` and `yolo`. Recorded in
 * `tests/fixtures/provider-traces/wire/reasonix-wire.json`, taken from
 * `reasonix v1.38.3` on 2026-09-09. Version 1.38.10 instead advertises
 * `read-only`, `workspace-write` and `danger-full-access`; select from the
 * session's options rather than assuming either vocabulary.
 *
 * Grimoire has three controls and Reasonix has two axes, so each Grimoire mode
 * names a point on both: Safe is `normal` asking before gated tools, Plan is
 * `plan` still asking, and Auto-approve is `normal` with full access. `goal` — keep
 * advancing the prompt until complete or blocked — is Reasonix's own and is
 * mapped from, never to: a session that reports it reads as Safe here, because
 * the toolbar has no fourth position to put it in.
 *
 * ponytail: known ceiling. `ask` gates the tools Reasonix classifies as
 * permission-gated, not every tool: a `bash` call running `ls -a` completed
 * unasked in the same turn a `write_file` raised a request (observed
 * 2026-09-09). What makes Safe safe here is the same thing that makes it safe
 * for every managed-ACP provider — a vault write travels through the client's
 * `fs/write_text_file`, where `AcpWorkspaceFileSystem` asks the tab. The
 * upgrade path for shell commands is ACP terminal delegation, which no provider
 * drives yet.
 */
export const REASONIX_SAFE_MODE_ID = 'normal';
export const REASONIX_PLAN_MODE_ID = 'plan';

/** What `tool_approval` is set to, per Grimoire mode. */
export const REASONIX_ASK_APPROVAL = 'ask';
export const REASONIX_YOLO_APPROVAL = 'yolo';

/** The session mode a Grimoire permission mode asks for. */
export function mapGrimoireModeToReasonix(mode: string | null | undefined): string {
  return mode === 'plan' ? REASONIX_PLAN_MODE_ID : REASONIX_SAFE_MODE_ID;
}

/** The `tool_approval` posture a Grimoire permission mode asks for. */
export function mapGrimoireModeToReasonixApproval(
  mode: string | null | undefined,
  availableValues?: readonly string[],
): string {
  const fullAccess = mode === 'full_access' || mode === 'yolo';
  const legacy = fullAccess ? REASONIX_YOLO_APPROVAL : REASONIX_ASK_APPROVAL;
  if (!availableValues) return legacy;
  const preset = fullAccess ? 'danger-full-access' : 'read-only';
  const value = [preset, legacy].find(candidate => availableValues.includes(candidate));
  if (value) return value;
  // Workspace write is not Safe: it permits edits without asking.
  throw new Error('Reasonix does not offer the requested tool approval policy.');
}

/**
 * The toolbar's word for a mode the session says it switched to.
 *
 * Auto-approve is not among the answers on purpose: it is a `tool_approval`
 * value, not a mode, so no `current_mode_update` can report it and adopting one
 * must never quietly drop the user out of Auto-approve.
 */
export function mapReasonixModeToGrimoire(mode: string | null | undefined): 'normal' | 'plan' {
  return mode === REASONIX_PLAN_MODE_ID ? 'plan' : 'normal';
}
