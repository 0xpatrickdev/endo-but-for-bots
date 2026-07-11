// @ts-check
/// <reference types="ses"/>

/** @import { CodeModeExecute } from './tool.js' */

/**
 * Build a Compartment-backed execute function. Callers supply every endowment
 * they want in lexical scope (typically `{ E, workspace, git }` plus stream
 * helpers). The completion value is returned; when `resultName` is supplied it
 * is also handed to `storeResult` for out-of-band capability storage.
 *
 * @param {object} options
 * @param {Record<string, unknown>} options.endowments
 * @param {(value: unknown, resultName: string | string[]) => Promise<void> | void} [options.storeResult]
 * @param {boolean} [options.exposeEmit] Bind `emit(value)` in each compartment.
 * @returns {CodeModeExecute}
 */
export const makeCompartmentExecute = ({
  endowments,
  storeResult,
  exposeEmit = false,
}) => {
  const hardenedEndowments = harden({ ...endowments });
  return async ({ source, resultName }, onUpdate) => {
    const compartmentEndowments =
      exposeEmit || onUpdate !== undefined
        ? harden({
            ...hardenedEndowments,
            emit: value => onUpdate?.(value),
          })
        : hardenedEndowments;
    const compartment = new Compartment(compartmentEndowments);
    const result = await compartment.evaluate(source);
    if (resultName !== undefined) {
      if (storeResult === undefined) {
        throw new Error(
          'execute.resultName was supplied but no storeResult callback is configured',
        );
      }
      await storeResult(result, resultName);
    }
    return result;
  };
};
harden(makeCompartmentExecute);
