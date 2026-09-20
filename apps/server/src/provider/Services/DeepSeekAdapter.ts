/**
 * DeepSeekAdapter — shape type for the DeepSeek Harness ACP adapter.
 *
 * @module DeepSeekAdapter
 */
import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

export interface DeepSeekAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {}
