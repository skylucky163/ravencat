/** 完全本地的像素画布；不接收提示词、图片、凭据或业务完成裁决。 */
import { IMAGE_GENERATION_PIXEL_SHADERS } from './imageGenerationPixelShader';

export function createImageGenerationPixelDocument(dark: boolean, reducedMotion: boolean, background: readonly number[]): string {
  const config = JSON.stringify({ dark, reducedMotion, background, shaders: IMAGE_GENERATION_PIXEL_SHADERS });
  return `<!doctype html><html><head>
<meta name="viewport" content="width=device-width,initial-scale=1,maximum-scale=1,user-scalable=no">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'">
<style>html,body,canvas{width:100%;height:100%;margin:0;overflow:hidden;background:transparent}canvas{display:block}</style>
</head><body><canvas></canvas><script>
(() => {
  const config = ${config};
  const post = event => window.ReactNativeWebView?.postMessage(event);
  const canvas = document.querySelector('canvas');
  let frame = 0;
  let dispose = () => {};
  const stop = () => { cancelAnimationFrame(frame); frame = 0; };
  window.addEventListener('pagehide', () => { stop(); dispose(); }, { once: true });
  canvas.addEventListener('webglcontextlost', event => { event.preventDefault(); stop(); post('failed'); });
  try {
    const gl = canvas.getContext('webgl', { alpha: true, premultipliedAlpha: false, antialias: false, depth: false, stencil: false, powerPreference: 'low-power' });
    if (!gl) throw new Error('WebGL unavailable');
    function compile(type, source) {
      const shader = gl.createShader(type);
      if (!shader) throw new Error('Unable to allocate shader');
      gl.shaderSource(shader, source); gl.compileShader(shader);
      if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
      return shader;
    }
    function program(source) {
      const vertex = compile(gl.VERTEX_SHADER, 'attribute vec2 position; void main(){gl_Position=vec4(position,0.0,1.0);}');
      const fragment = compile(gl.FRAGMENT_SHADER, source);
      const result = gl.createProgram();
      if (!result) throw new Error('Unable to allocate program');
      gl.attachShader(result, vertex); gl.attachShader(result, fragment); gl.linkProgram(result);
      gl.deleteShader(vertex); gl.deleteShader(fragment);
      if (!gl.getProgramParameter(result, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(result));
      return result;
    }
    const field = program(config.shaders.field), composite = program(config.shaders.composite);
    const buffer = gl.createBuffer(), texture = gl.createTexture(), target = gl.createFramebuffer();
    if (!buffer || !texture || !target) throw new Error('Unable to allocate drawing resources');
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1,-1,1,-1,-1,1,-1,1,1,-1,1,1]), gl.STATIC_DRAW);
    const uniforms = new Map();
    function location(program, name) {
      const key = (program === field ? 'field:' : 'composite:') + name;
      if (!uniforms.has(key)) uniforms.set(key, gl.getUniformLocation(program, name));
      return uniforms.get(key);
    }
    function use(program) {
      gl.useProgram(program);
      const attribute = gl.getAttribLocation(program, 'position');
      gl.enableVertexAttribArray(attribute); gl.vertexAttribPointer(attribute, 2, gl.FLOAT, false, 0, 0);
    }
    gl.bindTexture(gl.TEXTURE_2D, texture);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    const palette = config.dark ? [0x0f0f0f,0x4a4949,0xb9b9b9,0x0f0f0f,0xd8d8d8] : [0xa9afb8,0xf9fafb,0xd4d8df,0xe8ebf0,0x66707f];
    use(field);
    palette.forEach((value, index) => gl.uniform3f(location(field, 'u_color' + (index + 1)), (value >> 16 & 255) / 255, (value >> 8 & 255) / 255, (value & 255) / 255));
    gl.uniform1f(location(field, 'u_intensity'), config.dark ? 1 : 0.85);
    gl.uniform1f(location(field, 'u_direction'), config.dark ? 0 : 25 * Math.PI / 180);
    use(composite);
    gl.uniform1i(location(composite, 'u_field'), 0);
    gl.uniform1f(location(composite, 'u_dark'), Number(config.dark));
    gl.uniform3fv(location(composite, 'u_cardBg'), config.background);
    let gx, gy, dpr, revealedAt = null, lastFrame = -Infinity;
    function resize() {
      dpr = Math.min(window.devicePixelRatio, 1.5);
      const width = Math.max(1, canvas.clientWidth), height = Math.max(1, canvas.clientHeight);
      canvas.width = Math.round(width * dpr); canvas.height = Math.round(height * dpr);
      gx = Math.max(2, Math.floor(22.28 * width / 320)); gy = Math.max(2, Math.floor(22.28 * height / 320));
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gx, gy, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
      gl.bindFramebuffer(gl.FRAMEBUFFER, target);
      gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, texture, 0);
      if (gl.checkFramebufferStatus(gl.FRAMEBUFFER) !== gl.FRAMEBUFFER_COMPLETE) throw new Error('Incomplete pixel field framebuffer');
    }
    function draw(now) {
      const progress = revealedAt === null ? 0 : Math.min(1, (now - revealedAt) / 900);
      use(field); gl.bindFramebuffer(gl.FRAMEBUFFER, target); gl.viewport(0, 0, gx, gy);
      gl.uniform2f(location(field, 'u_grid'), gx, gy);
      gl.uniform2f(location(field, 'u_resolution'), canvas.width, canvas.height);
      gl.uniform1f(location(field, 'u_time'), config.reducedMotion ? 12 : now / 1000 + 12);
      // 纹理在第一遍作为输出、第二遍作为输入，避免采样与写入同一附件。
      gl.bindTexture(gl.TEXTURE_2D, null); gl.drawArrays(gl.TRIANGLES, 0, 6);
      use(composite); gl.bindFramebuffer(gl.FRAMEBUFFER, null); gl.viewport(0, 0, canvas.width, canvas.height);
      gl.bindTexture(gl.TEXTURE_2D, texture);
      gl.uniform2f(location(composite, 'u_grid'), gx, gy);
      gl.uniform2f(location(composite, 'u_resolution'), canvas.width, canvas.height);
      gl.uniform1f(location(composite, 'u_dpr'), dpr);
      gl.uniform1f(location(composite, 'u_reveal'), 1 - Math.pow(1 - progress, 3));
      gl.drawArrays(gl.TRIANGLES, 0, 6);
      if (progress === 1) { stop(); post('revealed'); return true; }
      return false;
    }
    function tick(now) {
      frame = 0;
      if (document.hidden) return;
      if (now - lastFrame >= 1000 / 24) {
        lastFrame = now;
        if (draw(now)) return;
      }
      frame = requestAnimationFrame(tick);
    }
    const observer = new ResizeObserver(() => { resize(); draw(performance.now()); });
    observer.observe(canvas);
    dispose = () => { observer.disconnect(); gl.deleteFramebuffer(target); gl.deleteTexture(texture); gl.deleteBuffer(buffer); gl.deleteProgram(field); gl.deleteProgram(composite); };
    document.addEventListener('visibilitychange', () => {
      stop();
      if (!document.hidden && !config.reducedMotion) frame = requestAnimationFrame(tick);
    });
    window.revealImage = () => {
      if (revealedAt !== null) return;
      if (config.reducedMotion) { post('revealed'); return; }
      revealedAt = performance.now();
    };
    resize(); draw(performance.now());
    if (!config.reducedMotion) frame = requestAnimationFrame(tick);
    post('ready');
  } catch (error) { stop(); console.error(error); post('failed'); }
})();
</script></body></html>`;
}
