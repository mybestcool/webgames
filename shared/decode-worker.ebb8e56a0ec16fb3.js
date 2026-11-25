import init, {decompress} from './decoder.5c51006e7bf04697.js';
const ready = init(new URL('./decoder.7cb4663fd0b11185.wasm', import.meta.url));
self.onmessage = async ({data: {id, input, expectedBytes}}) => {
  try {
    await ready;
    const result = decompress(new Uint8Array(input));
    if (result.byteLength !== expectedBytes) throw new Error('卡带解压长度错误');
    self.postMessage({id, output: result.buffer}, [result.buffer]);
  } catch (error) {
    self.postMessage({id, error: String(error)});
  }
};
