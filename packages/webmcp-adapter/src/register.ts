/**
 * Tool registration. Build plan §4.5, §24.
 *
 * A thin, honest wrapper. It does three things the raw call does not: it reports *why* registration
 * failed in terms a developer can act on, it enforces the naming and budget rules at registration
 * time rather than discovering them in an agent's behaviour, and it records what happened in the
 * runtime report so `/verify` can show it.
 */

import { modelContext, noteRuntime, setRuntime } from './support';

/** Chrome's documented guidance. Exceeding these does not throw; it degrades tool selection. */
export const BUDGETS = {
  /** Spec allows 1-128. Chrome guidance is 30, because a long name crowds the selection context. */
  nameChars: 30,
  descriptionChars: 500,
  parameterDescriptionChars: 150,
  /** Approximate. Per single tool output. */
  outputBytes: 1536,
} as const;

const NAME_RE = /^[A-Za-z0-9_.-]{1,128}$/;

export class RegistrationError extends Error {
  readonly toolName: string;
  constructor(toolName: string, message: string, options?: { cause?: unknown }) {
    super(`registerTool(${toolName}): ${message}`, options);
    this.name = 'RegistrationError';
    this.toolName = toolName;
  }
}

export type BudgetWarning = { tool: string; field: string; actual: number; budget: number };

const budgetWarnings: BudgetWarning[] = [];

export function budgetReport(): readonly BudgetWarning[] {
  return budgetWarnings;
}

/**
 * Check the documented budgets and record any overrun.
 *
 * Warnings rather than errors, deliberately. A description one character over budget should not
 * stop a demo, but nor should it pass unnoticed: an over-budget description is a tool an agent picks
 * less reliably, and that shows up as a mysterious eval regression rather than as an error.
 */
function checkBudgets(tool: ModelContextTool): void {
  const record = (field: string, actual: number, budget: number) => {
    if (actual > budget) {
      const warning = { tool: tool.name, field, actual, budget };
      budgetWarnings.push(warning);
      noteRuntime(`budget: ${tool.name}.${field} is ${actual}, guidance is ${budget}`);
    }
  };

  record('name', tool.name.length, BUDGETS.nameChars);
  record('description', tool.description.length, BUDGETS.descriptionChars);

  const schema = tool.inputSchema as { properties?: Record<string, { description?: string }> };
  for (const [prop, sub] of Object.entries(schema.properties ?? {})) {
    if (typeof sub?.description === 'string') {
      record(`inputSchema.${prop}.description`, sub.description.length, BUDGETS.parameterDescriptionChars);
    }
  }
}

/**
 * Register one tool.
 *
 * `registerTool` rejects with `InvalidStateError` on a duplicate name, an empty name or description,
 * or an invalid `inputSchema`. Those are all programming errors, so they are re-thrown as
 * `RegistrationError` with the tool named rather than being allowed to surface as an opaque DOM
 * exception four frames up.
 */
export async function registerWebMCPTool(
  tool: ModelContextTool,
  options?: ModelContextRegisterToolOptions,
): Promise<void> {
  if (!NAME_RE.test(tool.name)) {
    throw new RegistrationError(tool.name, 'name must match [A-Za-z0-9_.-]{1,128}');
  }
  if (tool.description.trim().length === 0) {
    throw new RegistrationError(tool.name, 'description must not be empty');
  }
  if (options?.exposedTo?.some((origin) => origin === '*' || origin.trim() === '')) {
    // Not a spec rule. A project rule: §23.3. A wildcard here would hand every origin on the web a
    // provider's tools, and the whole federation story rests on that not being possible.
    throw new RegistrationError(tool.name, 'exposedTo must name exact origins, never a wildcard');
  }

  checkBudgets(tool);

  try {
    await modelContext().registerTool(tool, options);
    setRuntime('register', 'present');
  } catch (cause) {
    setRuntime('register', 'absent');
    const reason = cause instanceof Error ? cause.message : String(cause);
    throw new RegistrationError(tool.name, reason, { cause });
  }
}

/**
 * Subscribe to `toolchange`.
 *
 * Fires whenever the accessible tool set changes, including when a *cross-origin* provider's tools
 * appear or disappear. That second case is what makes the offline control (§45) a demonstration
 * rather than an error path: the hub notices, rather than catching a failure.
 */
export function onToolChange(handler: () => void, signal?: AbortSignal): () => void {
  const mc = modelContext();
  const listener = () => handler();
  mc.addEventListener('toolchange', listener);
  const off = () => mc.removeEventListener('toolchange', listener);
  signal?.addEventListener('abort', off, { once: true });
  return off;
}
