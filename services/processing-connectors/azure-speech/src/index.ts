import {
  SignalDockError,
  type ConnectorManifest,
  type ProcessingConnection,
  type ProcessingProfile,
  type ProcessingRequest,
} from '@signaldock/contracts';
import type {
  ProcessingConnector,
  ProcessingExecutionContext,
} from '@signaldock/processing-sdk';
import {
  apiKey,
  audioInput,
  endpoint,
  jsonBody,
  object,
  request,
  requireContext,
  result,
  saveAudio,
  setting,
  stringValue,
} from '../../src/http.js';

function escapeXml(text: string): string {
  return text.replace(
    /[<>&'\"]/g,
    (character) =>
      ({
        '<': '&lt;',
        '>': '&gt;',
        '&': '&amp;',
        "'": '&apos;',
        '"': '&quot;',
      })[character]!,
  );
}
export class AzureSpeechConnector implements ProcessingConnector {
  describe(): ConnectorManifest {
    return {
      connectorId: 'azure-speech',
      version: '0.1.0',
      sdkVersion: 1,
      capabilities: ['stt.batch', 'tts.synthesize'],
      simulated: false,
      execution: 'cloud',
    };
  }
  async execute(
    input: ProcessingRequest,
    _connection: ProcessingConnection,
    profile: ProcessingProfile,
    signal: AbortSignal,
    resolved?: ProcessingExecutionContext,
  ) {
    const context = requireContext(resolved, profile.capability);
    const key = apiKey(context);
    if (profile.capability === 'stt.batch') {
      const audio = await audioInput(context, input, signal);
      const form = new FormData();
      form.set(
        'audio',
        new Blob([new Uint8Array(audio.bytes)], { type: audio.contentType }),
        'communication.wav',
      );
      form.set(
        'definition',
        JSON.stringify({ locales: [setting(context, 'language', true)] }),
      );
      const url = endpoint(
        context.endpoint,
        'speechtotext/transcriptions:transcribe',
        context.configuration,
      );
      url.searchParams.set('api-version', '2025-10-15');
      const payload = await jsonBody(
        await request(
          context,
          url,
          {
            method: 'POST',
            headers: { 'Ocp-Apim-Subscription-Key': key },
            body: form,
          },
          signal,
        ),
      );
      const phrases = payload['combinedPhrases'];
      if (!Array.isArray(phrases))
        throw new SignalDockError(
          'PROVIDER_UNAVAILABLE',
          'Azure returned an invalid transcription.',
        );
      return result(input, 'azure-speech', {
        kind: 'transcript',
        artifactId: audio.artifactId,
        text: phrases
          .map((phrase) => stringValue(object(phrase)['text'], 'transcript'))
          .join('\n'),
      });
    }
    if (profile.capability === 'tts.synthesize') {
      if (input.input.kind !== 'text')
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'Synthesis requires text.',
        );
      const configuredEndpoint = context.configuration['ttsEndpoint'];
      if (typeof configuredEndpoint !== 'string')
        throw new SignalDockError(
          'REQUIRES_CONFIGURATION',
          'Configure the Azure TTS base endpoint explicitly.',
        );
      const url = endpoint(
        configuredEndpoint,
        'cognitiveservices/v1',
        context.configuration,
      );
      if (
        !/\.(?:speech\.microsoft\.com|cognitiveservices\.azure\.com)$/.test(
          url.hostname,
        )
      )
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'The Azure TTS endpoint must be an Azure Speech service.',
        );
      const language = setting(context, 'language', true)!;
      const voice = setting(context, 'voice', true)!;
      if (!/^[A-Za-z0-9_-]+$/.test(language) || !/^[A-Za-z0-9_-]+$/.test(voice))
        throw new SignalDockError(
          'INVALID_ARGUMENT',
          'The Azure voice/locale setting is invalid.',
        );
      const response = await request(
        context,
        url,
        {
          method: 'POST',
          headers: {
            'Ocp-Apim-Subscription-Key': key,
            'Content-Type': 'application/ssml+xml',
            'X-Microsoft-OutputFormat': 'riff-24khz-16bit-mono-pcm',
            'User-Agent': 'SignalDock',
          },
          body: `<speak version="1.0" xml:lang="${language}"><voice name="${voice}">${escapeXml(input.input.text)}</voice></speak>`,
        },
        signal,
      );
      return result(
        input,
        'azure-speech',
        await saveAudio(context, input, response, signal),
      );
    }
    throw new SignalDockError(
      'CAPABILITY_UNSUPPORTED',
      'Azure Speech does not support this capability.',
    );
  }
}
