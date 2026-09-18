import { flattenAcpSessionConfigSelectOptions } from '@/providers/acp/AcpSessionConfig';
import type { AcpContentPayload } from '@/providers/acp/execution/AcpContentPayload';
import type { ManagedAcpClient } from '@/providers/acp/execution/ManagedAcpClient';
import type { AcpSessionConfigOption } from '@/providers/acp/types';
import {
  mapGrimoireModeToReasonix,
  mapGrimoireModeToReasonixApproval,
} from '@/providers/reasonix/modes';

import type { ReasonixExecutionDynamicApplier } from './ReasonixExecutionBackend';

/** What one Reasonix turn asks its session to be set to, once the session exists. */
export interface ReasonixAcpDynamicConfig {
  readonly modeId?: string;
  readonly modelId?: string;
  /**
   * The reasoning level this turn runs at, when the person picked one the
   * session offers. Absent for `auto`, which is Reasonix's own choice.
   */
  readonly effortLevel?: string;
}

export interface ReasonixAcpDynamicConfigResolver {
  resolve(dynamicRef: string): Promise<ReasonixAcpDynamicConfig>;
}

/** Told when the agent would not take the mode the vault asked for. */
export type ReasonixModeRefusedReporter = (input: {
  /** Grimoire's own word for it, which is what the person picked. */
  readonly modeId: string;
  /**
   * Which call refused it, since one Grimoire mode is two.
   *
   * The wire method rather than a name of this file's own, because the debug
   * log's safe-key list already admits `method` — a key nobody has thought
   * about is refused there, and `method` is one somebody did. Only ever
   * `session/set_mode`: a refused posture fails the turn rather than being
   * reported.
   */
  readonly method: 'session/set_mode';
  readonly error: unknown;
}) => void;

/**
 * Reasonix's own ordering, over the protocol-generic ACP kernel: the model,
 * then the approval posture, then the session mode.
 *
 * **One Grimoire mode is two calls here.** Reasonix separates what a session is
 * doing (`normal`, `plan`, `goal`, moved with `session/set_mode`) from how much
 * it may do unasked (`tool_approval`, moved with `session/set_config_option`);
 * Grimoire's toolbar drives both, and `modes.ts` selects the translation from
 * the session's advertised permission values. Both calls were probed on
 * 2026-09-09: `session/set_mode` answers `{}` and pushes a `current_mode_update`, and the config option answers
 * with the session's whole option list.
 *
 * **A posture that will not move fails the turn; a mode that will not move
 * does not.** Ordering alone cannot make the pair safe, which is what an
 * earlier version of this file claimed and got wrong: Safe and Auto-approve are
 * the *same* session mode, so the posture is the only thing that separates
 * them, and a swallowed `tool_approval` failure leaves a person who asked for
 * Safe running on `yolo` no matter which call went first. The posture is the
 * permission boundary, so a turn that cannot establish it must not be
 * dispatched. The mode is behaviour rather than permission, so a refused one is
 * reported and the turn runs in the mode the session already had.
 *
 * The model goes through `session/set_config_option` rather than
 * `session/set_model`. Reasonix answers both, and the config option is the one
 * that reports back what the session now holds, so a turn that ran on another
 * model than the badge shows is visible rather than silent.
 *
 * The model is strict for the same reason the posture is: a turn that silently
 * ran on a model other than the badge shows is worse than a failed one.
 */
export class ReasonixAcpDynamicConfigApplier implements ReasonixExecutionDynamicApplier {
  /** The sessions already told about a refusal, so a turn is not the unit. */
  private readonly reportedSessions = new Set<string>();
  /** Warm turns receive no opening reply; retain options only for this client and session. */
  private readonly sessionOptions = new WeakMap<ManagedAcpClient, {
    sessionId: string;
    approvalValues?: readonly string[];
    modelId?: string;
    effortLevel?: string;
  }>();

  constructor(
    private readonly resolver: ReasonixAcpDynamicConfigResolver,
    private readonly onModeRefused?: ReasonixModeRefusedReporter,
  ) {}

  async apply(input: Parameters<ReasonixExecutionDynamicApplier['apply']>[0]): Promise<void> {
    if (!input.dynamicRef) return;
    const config = await this.resolver.resolve(input.dynamicRef);
    throwIfAborted(input.signal);
    this.rememberSessionOptions(input, input.sessionConfigOptions);
    const known = this.sessionOptions.get(input.client);
    const currentModel = known?.sessionId === input.sessionId ? known.modelId : undefined;
    // Reasonix rebuilds its controller even when asked for the same model.
    if (config.modelId?.trim() && config.modelId.trim() !== currentModel) {
      const response = await input.client.setConfigOption({
        configId: 'model',
        sessionId: input.sessionId,
        type: 'select',
        value: config.modelId.trim(),
      });
      this.rememberSessionOptions(input, response.configOptions);
    }
    throwIfAborted(input.signal);
    // After the model, because the levels a session takes are the *model's*:
    // set on the previous model, a level the new one refuses fails the turn.
    // Tolerated rather than strict — an effort the agent will not take leaves
    // the session on whatever it was thinking at, which is a depth, not a
    // permission.
    const afterModel = this.sessionOptions.get(input.client);
    const currentEffort = afterModel?.sessionId === input.sessionId ? afterModel.effortLevel : undefined;
    // Reselecting unchanged effort rebuilds the controller and loses history too.
    if (config.effortLevel?.trim() && config.effortLevel.trim() !== currentEffort) {
      try {
        const response = await input.client.setConfigOption({
          configId: 'effort',
          sessionId: input.sessionId,
          type: 'select',
          value: config.effortLevel.trim(),
        });
        this.rememberSessionOptions(input, response.configOptions);
      } catch (error) {
        if (input.signal.aborted) {
          throw error;
        }
      }
    }
    throwIfAborted(input.signal);
    const requested = config.modeId?.trim();
    if (requested) {
      await this.applyMode(input, requested);
    }
  }

  private async applyMode(
    input: Parameters<ReasonixExecutionDynamicApplier['apply']>[0],
    grimoireMode: string,
  ): Promise<void> {
    const advertised = this.sessionOptions.get(input.client);
    // Not caught: the posture is what separates Safe from Auto-approve, so a
    // turn that could not set it has no permission boundary to run behind.
    await input.client.setConfigOption({
      configId: 'tool_approval',
      sessionId: input.sessionId,
      type: 'select',
      value: mapGrimoireModeToReasonixApproval(
        grimoireMode,
        advertised?.sessionId === input.sessionId ? advertised.approvalValues : undefined,
      ),
    });
    throwIfAborted(input.signal);

    try {
      await input.client.setMode({
        modeId: mapGrimoireModeToReasonix(grimoireMode),
        sessionId: input.sessionId,
      });
      this.reportedSessions.delete(input.sessionId);
    } catch (error) {
      if (input.signal.aborted) {
        throw error;
      }
      // Named in Grimoire's vocabulary, because that is what the person
      // picked and what the toolbar still shows. The agent's own id would
      // say "normal" for both Safe and Auto-approve, which are the two the
      // notice most needs to tell apart.
      this.onModeRefused?.({ error, method: 'session/set_mode', modeId: grimoireMode });
      if (this.reportedSessions.has(input.sessionId)) {
        return;
      }
      this.remember(input.sessionId);
      const detail = refusalDetail(error);
      input.presentContent?.({
        kind: 'mode-refused',
        modeId: grimoireMode,
        ...(detail ? { detail } : {}),
      } satisfies AcpContentPayload);
    }
  }

  private rememberSessionOptions(
    input: Parameters<ReasonixExecutionDynamicApplier['apply']>[0],
    options?: readonly AcpSessionConfigOption[],
  ): void {
    if (!options) return;
    const previous = this.sessionOptions.get(input.client);
    const approval = options.find(option => option.id === 'tool_approval');
    const model = options.find(option => option.id === 'model');
    const effort = options.find(option => option.id === 'effort');
    this.sessionOptions.set(input.client, {
      ...(previous?.sessionId === input.sessionId ? previous : {}),
      sessionId: input.sessionId,
      ...(approval?.type === 'select' ? {
        approvalValues: flattenAcpSessionConfigSelectOptions(approval.options).map(option => option.value),
      } : {}),
      ...(model?.type === 'select' ? { modelId: model.currentValue } : {}),
      ...(effort?.type === 'select' ? { effortLevel: effort.currentValue } : {}),
    });
  }

  /**
   * Records that this session has been told, and forgets the oldest.
   *
   * The applier is built once and lives as long as the plugin, while a session
   * id is minted per restart — and the launch key carries a workspace
   * generation that every vault change bumps. Unbounded, this would keep one
   * uuid per refusing session for the life of the process.
   */
  private remember(sessionId: string): void {
    this.reportedSessions.add(sessionId);
    while (this.reportedSessions.size > REPORTED_SESSION_MEMORY) {
      const oldest = this.reportedSessions.values().next();
      if (oldest.done) return;
      this.reportedSessions.delete(oldest.value);
    }
  }
}

/** How many sessions are remembered as already told about a refused mode. */
const REPORTED_SESSION_MEMORY = 64;

/**
 * The sentence worth showing, out of the error the agent sent.
 *
 * Reasonix puts its actionable text in `data.details` where it has any and in
 * the message otherwise; both are read, and the generic JSON-RPC text is not.
 */
function refusalDetail(error: unknown): string | undefined {
  const data = (error as { data?: unknown } | null)?.data;
  if (data && typeof data === 'object' && !Array.isArray(data)) {
    for (const key of ['details', 'uri']) {
      const value = (data as Record<string, unknown>)[key];
      if (typeof value === 'string' && value.trim()) {
        return value.trim();
      }
    }
  }
  const message = (error as { message?: unknown } | null)?.message;
  return typeof message === 'string' && message.trim() && message.trim() !== 'Internal error'
    ? message.trim()
    : undefined;
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw abortError(signal);
}

function abortError(signal: AbortSignal): Error {
  return signal.reason instanceof Error
    ? signal.reason
    : new Error('Reasonix dynamic configuration aborted.');
}
