"""앱 아이콘 생성 — 어두운 배경에 그라디언트 음표."""
from PIL import Image, ImageDraw
import os, math

OUT = os.path.join(os.path.dirname(os.path.dirname(os.path.abspath(__file__))), "icons")
os.makedirs(OUT, exist_ok=True)

BG_TOP, BG_BOT = (30, 22, 66), (13, 11, 26)
A1, A2 = (255, 61, 129), (124, 92, 255)

def lerp(a, b, t):
    return tuple(int(a[i] + (b[i] - a[i]) * t) for i in range(3))

def make(size):
    S = size * 4                      # 4배로 그린 뒤 축소해 계단 현상을 없앤다
    img = Image.new("RGB", (S, S), BG_BOT)
    d = ImageDraw.Draw(img)

    for y in range(S):                # 세로 그라디언트 배경
        d.line([(0, y), (S, y)], fill=lerp(BG_TOP, BG_BOT, y / S))

    # 은은한 광원
    glow = Image.new("RGB", (S, S), BG_BOT)
    gd = ImageDraw.Draw(glow)
    for r in range(int(S * 0.62), 0, -max(1, S // 220)):
        t = r / (S * 0.62)
        gd.ellipse([S/2 - r, S*0.30 - r, S/2 + r, S*0.30 + r], fill=lerp((58, 38, 110), BG_TOP, t))
    img = Image.blend(img, glow, 0.45)
    d = ImageDraw.Draw(img)

    # 음표: 기둥 + 깃발 + 머리 두 개
    stem_w = int(S * 0.055)
    x1, x2 = int(S * 0.36), int(S * 0.64)
    top, bot = int(S * 0.26), int(S * 0.68)

    def grad_rect(box, c1, c2):
        x0, y0, x1_, y1_ = box
        for y in range(y0, y1_):
            d.line([(x0, y), (x1_, y)], fill=lerp(c1, c2, (y - y0) / max(1, y1_ - y0)))

    grad_rect((x1, top, x1 + stem_w, bot), A1, A2)
    grad_rect((x2, top - int(S * 0.045), x2 + stem_w, bot - int(S * 0.045)), A1, A2)
    # 두 기둥을 잇는 보(beam)
    d.polygon([(x1, top), (x2 + stem_w, top - int(S * 0.045)),
               (x2 + stem_w, top + int(S * 0.075)), (x1, top + int(S * 0.12))], fill=A1)

    # 음표 머리
    hw, hh = int(S * 0.135), int(S * 0.105)
    for cx, cy in ((x1 + stem_w // 2, bot), (x2 + stem_w // 2, bot - int(S * 0.045))):
        d.ellipse([cx - hw, cy - hh, cx + hw - int(stem_w*0.4), cy + hh], fill=A2)

    return img.resize((size, size), Image.LANCZOS)

for s in (192, 512):
    make(s).save(os.path.join(OUT, f"icon-{s}.png"), optimize=True)
    print(f"  icons/icon-{s}.png 생성")
