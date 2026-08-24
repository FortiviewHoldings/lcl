/**
 * Microphone capture, off the main thread.
 *
 * This replaces ScriptProcessorNode, which is deprecated precisely because it
 * runs its callback on the page's own JavaScript thread. On the reporting
 * machine — Intel Smart Sound capture at 48 kHz — pressing the microphone
 * button killed the renderer process outright: the window stayed open, painted
 * black, and swallowed every click, while the app's children showed main,
 * gpu-process, utility, utility and no renderer at all.
 *
 * An AudioWorklet runs on the audio rendering thread, which is where audio
 * belongs. Frames are posted to the page, which only appends them to an array.
 *
 * Loaded as a module by audioWorklet.addModule() from the app's own origin,
 * so the strict CSP (script-src 'self') permits it.
 */
class MicCapture extends AudioWorkletProcessor {
    process(inputs) {
        const input = inputs[0];
        if (input && input[0] && input[0].length) {
            // a copy: the buffer handed in is reused by the audio thread on the
            // very next render quantum
            this.port.postMessage(new Float32Array(input[0]));
        }
        return true;                       // keep the node alive until stopped
    }
}
registerProcessor("mic-capture", MicCapture);
