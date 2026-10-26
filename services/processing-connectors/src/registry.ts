import { ProcessingRegistry, builtinProcessingTasks, type ProcessingTaskDefinition } from '@signaldock/processing-sdk';
import { OpenAIApiConnector } from '../openai-api/src/index.js';
import { OpenAICompatibleConnector } from '../openai-compatible/src/index.js';
import { OpenAISubscriptionConnector } from '../openai-subscription-oauth/src/index.js';
import { AzureSpeechConnector } from '../azure-speech/src/index.js';
import { OllamaConnector } from '../ollama/src/index.js';

export function createProcessingRegistry(tasks: readonly ProcessingTaskDefinition[] = builtinProcessingTasks()) {
  const registry = new ProcessingRegistry(tasks);
  for (const connector of [new OpenAIApiConnector(), new OpenAICompatibleConnector(), new OpenAISubscriptionConnector(), new AzureSpeechConnector(), new OllamaConnector()]) registry.register(connector);
  return registry;
}
