/**
 * 최소 QR 인코더 (바이트 모드, 버전 1~10).
 *
 * Client ID 32자리를 다른 기기로 옮기려고 만들었다. 손으로 치기엔 길고,
 * 외부 라이브러리를 불러오면 오프라인에서 못 쓰게 되므로 직접 구현했다.
 *
 *   QR.render(canvas, "문자열")
 */

const QR = (() => {
  // ---------- 갈루아 필드 (Reed-Solomon 오류정정용) ----------
  const EXP = new Uint8Array(512);
  const LOG = new Uint8Array(256);
  (() => {
    let x = 1;
    for (let i = 0; i < 255; i++) {
      EXP[i] = x;
      LOG[x] = i;
      x <<= 1;
      if (x & 0x100) x ^= 0x11d;      // QR 규격의 기약다항식
    }
    for (let i = 255; i < 512; i++) EXP[i] = EXP[i - 255];
  })();

  const mul = (a, b) => (a === 0 || b === 0 ? 0 : EXP[LOG[a] + LOG[b]]);

  function rsGenerator(deg) {
    let poly = [1];
    for (let i = 0; i < deg; i++) {
      const next = new Array(poly.length + 1).fill(0);
      for (let j = 0; j < poly.length; j++) {
        next[j] ^= mul(poly[j], 1);
        next[j + 1] ^= mul(poly[j], EXP[i]);
      }
      poly = next;
    }
    return poly;
  }

  function rsEncode(data, ecLen) {
    const gen = rsGenerator(ecLen);
    const res = new Uint8Array(data.length + ecLen);
    res.set(data);
    for (let i = 0; i < data.length; i++) {
      const factor = res[i];
      if (factor === 0) continue;
      for (let j = 0; j < gen.length; j++) res[i + j] ^= mul(gen[j], factor);
    }
    return res.slice(data.length);
  }

  // ---------- 버전별 제원 (오류정정 레벨 L 기준) ----------
  // [총 코드워드, EC 코드워드/블록, 블록1 수, 블록1 데이터워드, 블록2 수, 블록2 데이터워드]
  const SPEC = {
    1:  [26, 7, 1, 19, 0, 0],
    2:  [44, 10, 1, 34, 0, 0],
    3:  [70, 15, 1, 55, 0, 0],
    4:  [100, 20, 1, 80, 0, 0],
    5:  [134, 26, 1, 108, 0, 0],
    6:  [172, 18, 2, 68, 0, 0],
    7:  [196, 20, 2, 78, 0, 0],
    8:  [242, 24, 2, 97, 0, 0],
    9:  [292, 30, 2, 116, 0, 0],
    10: [346, 18, 2, 68, 2, 69],
  };

  const ALIGN = {
    1: [], 2: [6, 18], 3: [6, 22], 4: [6, 26], 5: [6, 30],
    6: [6, 34], 7: [6, 22, 38], 8: [6, 24, 42], 9: [6, 26, 46], 10: [6, 28, 50],
  };

  // 버전 1~10 의 형식정보(EC 레벨 L + 마스크 0~7). 규격표 값을 그대로 쓴다.
  const FORMAT_L = [
    0x77c4, 0x72f3, 0x7daa, 0x789d, 0x662f, 0x6318, 0x6c41, 0x6976,
  ];

  function capacity(ver) {
    const [, ec, b1, d1, b2, d2] = SPEC[ver];
    return (b1 * d1 + b2 * d2);
  }

  function pickVersion(byteLen) {
    for (let v = 1; v <= 10; v++) {
      // 모드지시자 4비트 + 길이필드(버전 10 이하는 8비트) + 데이터
      const need = 2 + byteLen;
      if (capacity(v) >= need) return v;
    }
    throw new Error('데이터가 너무 깁니다');
  }

  // ---------- 비트 스트림 ----------
  class BitBuffer {
    constructor() { this.bits = []; }
    put(val, len) {
      for (let i = len - 1; i >= 0; i--) this.bits.push((val >>> i) & 1);
    }
    get length() { return this.bits.length; }
    toBytes() {
      const out = new Uint8Array(Math.ceil(this.bits.length / 8));
      this.bits.forEach((b, i) => { if (b) out[i >> 3] |= 0x80 >> (i & 7); });
      return out;
    }
  }

  function buildData(text, ver) {
    const bytes = new TextEncoder().encode(text);
    const buf = new BitBuffer();
    buf.put(0b0100, 4);            // 바이트 모드
    buf.put(bytes.length, 8);      // 버전 1~9 는 길이 8비트
    bytes.forEach((b) => buf.put(b, 8));

    const total = capacity(ver) * 8;
    buf.put(0, Math.min(4, total - buf.length));        // 종료 패턴
    while (buf.length % 8) buf.bits.push(0);

    const data = Array.from(buf.toBytes());
    const pad = [0xec, 0x11];
    for (let i = 0; data.length < capacity(ver); i++) data.push(pad[i % 2]);
    return Uint8Array.from(data);
  }

  /** 블록으로 나눠 인터리브한다. */
  function interleave(data, ver) {
    const [, ecLen, b1, d1, b2, d2] = SPEC[ver];
    const blocks = [];
    let pos = 0;
    for (let i = 0; i < b1; i++) { blocks.push(data.slice(pos, pos + d1)); pos += d1; }
    for (let i = 0; i < b2; i++) { blocks.push(data.slice(pos, pos + d2)); pos += d2; }

    const ecBlocks = blocks.map((b) => rsEncode(b, ecLen));
    const out = [];
    const maxData = Math.max(...blocks.map((b) => b.length));
    for (let i = 0; i < maxData; i++) {
      for (const b of blocks) if (i < b.length) out.push(b[i]);
    }
    for (let i = 0; i < ecLen; i++) {
      for (const b of ecBlocks) out.push(b[i]);
    }
    return Uint8Array.from(out);
  }

  // ---------- 매트릭스 ----------
  function makeMatrix(ver) {
    const size = ver * 4 + 17;
    const m = Array.from({ length: size }, () => new Array(size).fill(null));
    const reserved = Array.from({ length: size }, () => new Array(size).fill(false));

    const setF = (r, c, v) => { m[r][c] = v; reserved[r][c] = true; };

    // 위치 검출 패턴 3개 + 분리자
    for (const [br, bc] of [[0, 0], [0, size - 7], [size - 7, 0]]) {
      for (let r = -1; r <= 7; r++) {
        for (let c = -1; c <= 7; c++) {
          const rr = br + r, cc = bc + c;
          if (rr < 0 || rr >= size || cc < 0 || cc >= size) continue;
          const on = (r >= 0 && r <= 6 && (c === 0 || c === 6)) ||
                     (c >= 0 && c <= 6 && (r === 0 || r === 6)) ||
                     (r >= 2 && r <= 4 && c >= 2 && c <= 4);
          setF(rr, cc, on ? 1 : 0);
        }
      }
    }

    // 정렬 패턴
    const pos = ALIGN[ver];
    for (const r of pos) {
      for (const c of pos) {
        if (reserved[r][c]) continue;
        for (let dr = -2; dr <= 2; dr++) {
          for (let dc = -2; dc <= 2; dc++) {
            const on = Math.max(Math.abs(dr), Math.abs(dc)) !== 1;
            setF(r + dr, c + dc, on ? 1 : 0);
          }
        }
      }
    }

    // 타이밍 패턴
    for (let i = 8; i < size - 8; i++) {
      if (!reserved[6][i]) setF(6, i, i % 2 === 0 ? 1 : 0);
      if (!reserved[i][6]) setF(i, 6, i % 2 === 0 ? 1 : 0);
    }

    setF(size - 8, 8, 1);   // 항상 검은 모듈

    // 형식정보 자리 예약
    for (let i = 0; i < 9; i++) {
      if (!reserved[8][i]) { m[8][i] = 0; reserved[8][i] = true; }
      if (!reserved[i][8]) { m[i][8] = 0; reserved[i][8] = true; }
    }
    for (let i = 0; i < 8; i++) {
      if (!reserved[8][size - 1 - i]) { m[8][size - 1 - i] = 0; reserved[8][size - 1 - i] = true; }
      if (!reserved[size - 1 - i][8]) { m[size - 1 - i][8] = 0; reserved[size - 1 - i][8] = true; }
    }

    return { m, reserved, size };
  }

  const MASKS = [
    (r, c) => (r + c) % 2 === 0,
    (r) => r % 2 === 0,
    (r, c) => c % 3 === 0,
    (r, c) => (r + c) % 3 === 0,
    (r, c) => (Math.floor(r / 2) + Math.floor(c / 3)) % 2 === 0,
    (r, c) => ((r * c) % 2) + ((r * c) % 3) === 0,
    (r, c) => (((r * c) % 2) + ((r * c) % 3)) % 2 === 0,
    (r, c) => (((r + c) % 2) + ((r * c) % 3)) % 2 === 0,
  ];

  function placeData(m, reserved, size, bytes) {
    let bitIdx = 0;
    const totalBits = bytes.length * 8;
    let up = true;
    for (let col = size - 1; col > 0; col -= 2) {
      if (col === 6) col--;                       // 타이밍 열은 건너뛴다
      for (let i = 0; i < size; i++) {
        const row = up ? size - 1 - i : i;
        for (const c of [col, col - 1]) {
          if (reserved[row][c]) continue;
          let bit = 0;
          if (bitIdx < totalBits) {
            bit = (bytes[bitIdx >> 3] >> (7 - (bitIdx & 7))) & 1;
            bitIdx++;
          }
          m[row][c] = bit;
        }
      }
      up = !up;
    }
  }

  /** 규격의 벌점 규칙. 가장 읽기 쉬운 마스크를 고르는 데 쓴다. */
  function penalty(m, size) {
    let score = 0;
    const runScore = (line) => {
      let s = 0, run = 1;
      for (let i = 1; i < size; i++) {
        if (line[i] === line[i - 1]) run++;
        else { if (run >= 5) s += 3 + (run - 5); run = 1; }
      }
      if (run >= 5) s += 3 + (run - 5);
      return s;
    };
    for (let r = 0; r < size; r++) score += runScore(m[r]);
    for (let c = 0; c < size; c++) score += runScore(m.map((row) => row[c]));

    for (let r = 0; r < size - 1; r++) {
      for (let c = 0; c < size - 1; c++) {
        const v = m[r][c];
        if (v === m[r][c + 1] && v === m[r + 1][c] && v === m[r + 1][c + 1]) score += 3;
      }
    }

    let dark = 0;
    for (let r = 0; r < size; r++) for (let c = 0; c < size; c++) dark += m[r][c];
    const ratio = (dark * 100) / (size * size);
    score += Math.floor(Math.abs(ratio - 50) / 5) * 10;
    return score;
  }

  function applyFormat(m, size, mask) {
    const fmt = FORMAT_L[mask];
    for (let i = 0; i < 15; i++) {
      const bit = (fmt >> i) & 1;
      // 좌상단
      if (i < 6) m[8][i] = bit;
      else if (i === 6) m[8][7] = bit;
      else if (i === 7) m[8][8] = bit;
      else if (i === 8) m[7][8] = bit;
      else m[14 - i][8] = bit;
      // 우상단 / 좌하단
      if (i < 8) m[size - 1 - i][8] = bit;
      else m[8][size - 15 + i] = bit;
    }
  }

  function encode(text) {
    const bytes = new TextEncoder().encode(text);
    const ver = pickVersion(bytes.length);
    const data = buildData(text, ver);
    const codewords = interleave(data, ver);

    const { m, reserved, size } = makeMatrix(ver);
    placeData(m, reserved, size, codewords);

    let best = null;
    for (let mask = 0; mask < 8; mask++) {
      const test = m.map((row) => row.slice());
      for (let r = 0; r < size; r++) {
        for (let c = 0; c < size; c++) {
          if (!reserved[r][c] && MASKS[mask](r, c)) test[r][c] ^= 1;
        }
      }
      applyFormat(test, size, mask);
      const p = penalty(test, size);
      if (!best || p < best.p) best = { p, matrix: test };
    }
    return { matrix: best.matrix, size };
  }

  /** 캔버스에 그린다. 여백(quiet zone)이 없으면 인식률이 떨어져 4모듈 남긴다. */
  function render(canvas, text, { scale = 6, quiet = 4, dark = '#000', light = '#fff' } = {}) {
    const { matrix, size } = encode(text);
    const px = (size + quiet * 2) * scale;
    canvas.width = px;
    canvas.height = px;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, px, px);
    ctx.fillStyle = dark;
    for (let r = 0; r < size; r++) {
      for (let c = 0; c < size; c++) {
        if (matrix[r][c]) {
          ctx.fillRect((c + quiet) * scale, (r + quiet) * scale, scale, scale);
        }
      }
    }
    return canvas;
  }

  return { encode, render };
})();

window.QR = QR;
