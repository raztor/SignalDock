export { OpenAIApiConnector } from '../openai-api/src/index.js';
export { OpenAICompatibleConnector } from '../openai-compatible/src/index.js';
export {
  OpenAISubscriptionConnector,
  completedText,
} from '../openai-subscription-oauth/src/index.js';
export {
  OpenAISubscriptionOAuth,
  type SubscriptionRegistration,
  type PendingSubscriptionAuthorization,
} from '../openai-subscription-oauth/src/oauth.js';
export { AzureSpeechConnector } from '../azure-speech/src/index.js';
export { OllamaConnector } from '../ollama/src/index.js';
export { ProviderRequestError } from './http.js';
export {
  CredentialVault,
  type CredentialScope,
  type CredentialEnvelope,
} from './vault.js';
export { createProcessingRegistry } from './registry.js';
export {
  ProcessingRuntime,
  type ProcessingRuntimeOptions,
  type ProcessingActor,
  type CreateProcessingConnection,
} from './runtime.js';
export {
  createHistoryProcessingHooks,
  type ProcessingHistoryPort,
} from './history.js';
export { removeProcessingSourceDerivatives } from './retention.js';
