/**
 * 폰을 엎으면 재생을 시작하는 입력 장치.
 *
 * 힛스터가 쓰는 방식이다. 화면이 바닥을 향하니 알림창이든 뭐든 볼 수가 없어서
 * 정답 노출을 물리적으로 차단하는 효과가 있다.
 *
 * 기울기(DeviceOrientation) 대신 중력 가속도(DeviceMotion)를 쓴다.
 * z 축 중력은 화면이 위를 보면 +9.8, 아래를 보면 -9.8 로 부호가 뚜렷하게 갈려서
 * 기기·제조사에 따라 값이 들쭉날쭉한 beta/gamma 보다 훨씬 안정적이다.
 */

class FlipDetector {
  /**
   * @param {object} opts
   * @param {number} opts.threshold  이 값보다 z 중력이 작으면 엎은 것으로 본다 (m/s²)
   * @param {number} opts.holdMs     흔들림으로 인한 오작동을 막기 위해 유지해야 하는 시간
   */
  constructor({ threshold = -7, holdMs = 350 } = {}) {
    this.threshold = threshold;
    this.holdMs = holdMs;
    this.listening = false;
    this.faceDown = false;
    this._since = 0;
    this._onFlip = null;
    this._onRestore = null;
    this._handler = this._handler.bind(this);
  }

  /** 이 브라우저에서 쓸 수 있는지. HTTPS(보안 컨텍스트)가 아니면 센서 이벤트가 오지 않는다. */
  static get supported() {
    return typeof DeviceMotionEvent !== 'undefined' && window.isSecureContext;
  }

  /** iOS 13+ 는 사용자 제스처 안에서 권한을 물어야 한다. 버튼 클릭 핸들러에서 호출할 것. */
  static async requestPermission() {
    if (typeof DeviceMotionEvent?.requestPermission !== 'function') return true;
    try {
      return (await DeviceMotionEvent.requestPermission()) === 'granted';
    } catch (_) {
      return false;
    }
  }

  _handler(e) {
    const z = e.accelerationIncludingGravity?.z;
    if (typeof z !== 'number') return;

    const down = z < this.threshold;
    const now = performance.now();

    if (down !== this.faceDown) {
      // 상태가 바뀐 순간부터 holdMs 만큼 유지돼야 진짜 뒤집은 것으로 인정한다
      if (!this._since) this._since = now;
      if (now - this._since >= this.holdMs) {
        this.faceDown = down;
        this._since = 0;
        (down ? this._onFlip : this._onRestore)?.();
      }
    } else {
      this._since = 0;
    }
  }

  start() {
    if (this.listening || !FlipDetector.supported) return false;
    window.addEventListener('devicemotion', this._handler);
    this.listening = true;
    return true;
  }

  stop() {
    if (!this.listening) return;
    window.removeEventListener('devicemotion', this._handler);
    this.listening = false;
    this.faceDown = false;
    this._since = 0;
  }

  onFlip(fn) { this._onFlip = fn; return this; }
  onRestore(fn) { this._onRestore = fn; return this; }
}

window.FlipDetector = FlipDetector;
