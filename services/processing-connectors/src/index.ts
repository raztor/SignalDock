export { OpenAIApiConnector } from '../openai-api/src/index.js';
export { OpenAICompatibleConnector } from '../openai-compatible/src/index.js';
export { OpenAISubscriptionConnector, completedText } from '../openai-subscription-oauth/src/index.js';
export { AzureSpeechConnector } from '../azure-speech/src/index.js';
export { OllamaConnector } from '../ollama/src/index.js';
export { ProviderRequestError } from './http.js';
export { CredentialVault, type CredentialScope, type CredentialEnvelope } from './vault.js';
export { createProcessingRegistry } from './registry.js';
