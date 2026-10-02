// Platform-owned identity. Holder messages and token metadata cannot change it.
export const KURT = Object.freeze({
  name: 'Kurt', character: 'wolf', version: 1,
  voice: Object.freeze({
    name: 'Dennis', provider: 'NanoGPT', model: 'inworld/realtime-tts-2',
    enabled: false, status: 'awaiting_billing_configuration',
  }),
});
