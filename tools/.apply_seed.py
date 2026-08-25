"""시드 갱신을 원자적으로 처리하는 공용 도우미."""
import csv, os, sys, tempfile
SEED = os.path.join(os.path.dirname(os.path.abspath(__file__)), "seed_ost.csv")
FIELDS = ["year","type","work","characters","actors","song","artist","search","alt","verified"]

def read():
    with open(SEED, encoding="utf-8") as f:
        return list(csv.DictReader(f))

def write(rows):
    fd, tmp = tempfile.mkstemp(dir=os.path.dirname(SEED), suffix=".csv")
    try:
        with os.fdopen(fd, "w", encoding="utf-8", newline="") as f:
            w = csv.DictWriter(f, fieldnames=FIELDS, extrasaction="ignore")
            w.writeheader()
            for r in rows:
                w.writerow({k: r.get(k, "") for k in FIELDS})
        os.replace(tmp, SEED)
    except BaseException:
        if os.path.exists(tmp): os.remove(tmp)
        raise
