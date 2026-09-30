"""네이버 플레이스 리뷰 사진 다운로더 — 창 프로그램."""
import os
import queue
import sys
import threading
import traceback
from datetime import date, datetime, timedelta
import tkinter as tk
from tkinter import filedialog, messagebox, ttk

from ppd import config
from ppd.dates import parse_input_date
from ppd.job import Job, JobOptions, StopRequested

APP_TITLE = "네이버 플레이스 리뷰 사진 다운로더"
DEFAULT_OUT = os.path.join(os.path.expanduser("~"), "Downloads", "플레이스리뷰사진")


class App:
    def __init__(self, root):
        self.root = root
        root.title(APP_TITLE)
        root.geometry("780x640")
        root.minsize(600, 460)
        self.msgs = queue.Queue()
        self.stop_event = threading.Event()
        self.worker = None
        self.log_file = None

        pad = {"padx": 8, "pady": 4}
        frm = ttk.Frame(root, padding=10)
        frm.pack(fill="both", expand=True)
        frm.columnconfigure(1, weight=1)

        cfg = config.load()
        r = 0
        ttk.Label(frm, text="방식").grid(row=r, column=0, sticky="w", **pad)
        modes = ttk.Frame(frm)
        modes.grid(row=r, column=1, columnspan=3, sticky="w", **pad)
        self.mode = tk.StringVar(value=cfg.get("mode", "api"))
        ttk.Radiobutton(modes, text="공식 검색 API (추천, 보안확인 없음)", value="api", variable=self.mode,
                        command=self._sync_mode).pack(side="left")
        ttk.Radiobutton(modes, text="플레이스 화면 (방문자리뷰 가능, 보안확인 뜰 수 있음)", value="browser",
                        variable=self.mode, command=self._sync_mode).pack(side="left", padx=12)

        r += 1
        ttk.Label(frm, text="플레이스 링크").grid(row=r, column=0, sticky="w", **pad)
        self.link = tk.StringVar()
        ttk.Entry(frm, textvariable=self.link).grid(row=r, column=1, columnspan=3, sticky="ew", **pad)

        r += 1
        ttk.Label(frm, text="상호명(선택)").grid(row=r, column=0, sticky="w", **pad)
        self.place_name = tk.StringVar()
        self.name_entry = ttk.Entry(frm, textvariable=self.place_name)
        self.name_entry.grid(row=r, column=1, sticky="ew", **pad)
        self.name_hint = ttk.Label(frm, text="비우면 링크에서 자동으로 찾음", foreground="gray")
        self.name_hint.grid(row=r, column=2, columnspan=2, sticky="w", **pad)

        r += 1
        ttk.Label(frm, text="네이버 API 키").grid(row=r, column=0, sticky="w", **pad)
        keys = ttk.Frame(frm)
        keys.grid(row=r, column=1, columnspan=3, sticky="ew", **pad)
        self.client_id = tk.StringVar(value=cfg.get("client_id", ""))
        self.client_secret = tk.StringVar(value=cfg.get("client_secret", ""))
        ttk.Label(keys, text="Client ID").pack(side="left")
        self.id_entry = ttk.Entry(keys, textvariable=self.client_id, width=24)
        self.id_entry.pack(side="left", padx=(4, 12))
        ttk.Label(keys, text="Secret").pack(side="left")
        self.secret_entry = ttk.Entry(keys, textvariable=self.client_secret, width=16, show="●")
        self.secret_entry.pack(side="left", padx=4)

        today = date.today()
        r += 1
        ttk.Label(frm, text="기간").grid(row=r, column=0, sticky="w", **pad)
        dates = ttk.Frame(frm)
        dates.grid(row=r, column=1, columnspan=3, sticky="w", **pad)
        self.start = tk.StringVar(value=(today - timedelta(days=90)).isoformat())
        self.end = tk.StringVar(value=today.isoformat())
        ttk.Entry(dates, textvariable=self.start, width=12).pack(side="left")
        ttk.Label(dates, text=" ~ ").pack(side="left")
        ttk.Entry(dates, textvariable=self.end, width=12).pack(side="left")
        for label, days in (("1개월", 30), ("3개월", 90), ("6개월", 180), ("1년", 365)):
            ttk.Button(dates, text=label, width=6,
                       command=lambda d=days: self._set_range(d)).pack(side="left", padx=(6, 0))

        r += 1
        ttk.Label(frm, text="저장 폴더").grid(row=r, column=0, sticky="w", **pad)
        self.out = tk.StringVar(value=cfg.get("out_dir", DEFAULT_OUT))
        ttk.Entry(frm, textvariable=self.out).grid(row=r, column=1, columnspan=2, sticky="ew", **pad)
        ttk.Button(frm, text="찾아보기", command=self._pick_dir).grid(row=r, column=3, **pad)

        r += 1
        opts = ttk.Frame(frm)
        opts.grid(row=r, column=0, columnspan=4, sticky="w", **pad)
        self.visitor = tk.BooleanVar(value=False)
        self.headless = tk.BooleanVar(value=False)
        self.visitor_cb = ttk.Checkbutton(opts, text="방문자리뷰 사진도 받기", variable=self.visitor)
        self.visitor_cb.pack(side="left")
        self.headless_cb = ttk.Checkbutton(opts, text="브라우저 창 숨기기", variable=self.headless)
        self.headless_cb.pack(side="left", padx=12)
        ttk.Label(opts, text="최대 확인 글 수").pack(side="left", padx=(12, 4))
        self.max_reviews = tk.StringVar(value=str(cfg.get("max_reviews", 300)))
        ttk.Spinbox(opts, from_=10, to=3000, increment=50, width=6,
                    textvariable=self.max_reviews).pack(side="left")
        self._row_buttons = r + 1

        btns = ttk.Frame(frm)
        btns.grid(row=self._row_buttons, column=0, columnspan=4, sticky="ew", **pad)
        self.start_btn = ttk.Button(btns, text="시작", command=self._start)
        self.start_btn.pack(side="left")
        self.stop_btn = ttk.Button(btns, text="중지", command=self._stop, state="disabled")
        self.stop_btn.pack(side="left", padx=6)
        self.open_btn = ttk.Button(btns, text="폴더 열기", command=self._open_folder)
        self.open_btn.pack(side="left")
        self.progress = ttk.Progressbar(btns, mode="determinate")
        self.progress.pack(side="left", fill="x", expand=True, padx=(12, 0))

        self.logbox = tk.Text(frm, height=18, wrap="word", state="disabled")
        log_row = self._row_buttons + 1
        self.logbox.grid(row=log_row, column=0, columnspan=4, sticky="nsew", **pad)
        frm.rowconfigure(log_row, weight=1)
        sb = ttk.Scrollbar(frm, command=self.logbox.yview)
        sb.grid(row=log_row, column=4, sticky="ns")
        self.logbox["yscrollcommand"] = sb.set

        self._append("링크를 붙여넣고 [시작]을 누르세요. (naver.me 공유 링크, 지도/플레이스 주소 모두 가능)\n"
                     "공식 API 방식: 네이버 개발자센터의 검색 API 키가 필요합니다 (한 번 입력하면 이 PC에 저장).\n"
                     "플레이스 화면 방식: 보안확인이 뜨면 브라우저 창에서 직접 풀어주세요.")
        self._sync_mode()
        root.protocol("WM_DELETE_WINDOW", self._on_close)
        root.after(100, self._pump)

    # ---------- UI 동작 ----------
    def _sync_mode(self):
        api = self.mode.get() == "api"
        for w in (self.id_entry, self.secret_entry, self.name_entry):
            w["state"] = "normal" if api else "disabled"
        for w in (self.visitor_cb, self.headless_cb):
            w["state"] = "disabled" if api else "normal"
        if api:
            self.visitor.set(False)

    def _set_range(self, days):
        today = date.today()
        self.start.set((today - timedelta(days=days)).isoformat())
        self.end.set(today.isoformat())

    def _pick_dir(self):
        d = filedialog.askdirectory(initialdir=self.out.get() or os.path.expanduser("~"))
        if d:
            self.out.set(d)

    def _open_folder(self):
        path = getattr(self, "last_folder", None) or self.out.get()
        os.makedirs(path, exist_ok=True)
        if sys.platform.startswith("win"):
            os.startfile(path)  # noqa: S606 - 사용자 폴더 열기
        else:
            messagebox.showinfo(APP_TITLE, path)

    def _start(self):
        link = self.link.get().strip()
        start, end = parse_input_date(self.start.get()), parse_input_date(self.end.get())
        mode = self.mode.get()
        if not link and not (mode == "api" and self.place_name.get().strip()):
            return messagebox.showwarning(APP_TITLE, "플레이스 링크를 입력하세요. (공식 API 방식은 상호명만 입력해도 됩니다)")
        if mode == "api" and not (self.client_id.get().strip() and self.client_secret.get().strip()):
            return messagebox.showwarning(APP_TITLE, "네이버 API Client ID와 Secret을 입력하세요.\n"
                                          "(developers.naver.com → 애플리케이션 등록 → 검색 API)")
        if not start or not end:
            return messagebox.showwarning(APP_TITLE, "기간을 2026-01-31 형식으로 입력하세요.")
        if start > end:
            return messagebox.showwarning(APP_TITLE, "시작일이 종료일보다 늦습니다.")
        try:
            max_reviews = max(10, int(self.max_reviews.get()))
        except ValueError:
            return messagebox.showwarning(APP_TITLE, "최대 확인 리뷰 수는 숫자로 입력하세요.")

        out_dir = self.out.get().strip() or DEFAULT_OUT
        os.makedirs(out_dir, exist_ok=True)
        self.log_file = open(os.path.join(out_dir, f"_로그_{datetime.now():%Y%m%d_%H%M%S}.txt"),
                             "w", encoding="utf-8")
        try:
            config.save({"mode": mode, "client_id": self.client_id.get().strip(),
                         "client_secret": self.client_secret.get().strip(),
                         "out_dir": out_dir, "max_reviews": max_reviews})
        except OSError:
            pass  # 설정 저장 실패는 작업을 막지 않는다
        opts = JobOptions(link=link, start=start, end=end, out_dir=out_dir,
                          include_visitor=self.visitor.get(), headless=self.headless.get(),
                          max_reviews=max_reviews, mode=mode, client_id=self.client_id.get(),
                          client_secret=self.client_secret.get(), place_name=self.place_name.get())
        self.stop_event.clear()
        self.start_btn["state"], self.stop_btn["state"] = "disabled", "normal"
        self.progress["value"] = 0
        self.worker = threading.Thread(target=self._run, args=(opts,), daemon=True)
        self.worker.start()

    def _stop(self):
        self.stop_event.set()
        self._append("중지 요청 — 현재 사진까지 처리 후 멈춥니다…")

    def _run(self, opts):
        job = Job(opts, log=lambda m: self.msgs.put(("log", m)),
                  progress=lambda d, t: self.msgs.put(("progress", (d, t))),
                  stop_event=self.stop_event)
        try:
            folder = job.run()
            self.msgs.put(("done", folder))
        except StopRequested:
            self.msgs.put(("log", "중지했습니다. 받은 사진은 그대로 남아 있습니다."))
            self.msgs.put(("done", None))
        except Exception as e:  # noqa: BLE001 - 사용자에게 오류를 보여준다
            self.msgs.put(("log", "오류: " + str(e)))
            self.msgs.put(("log", traceback.format_exc()))
            self.msgs.put(("error", str(e)))

    def _pump(self):
        try:
            while True:
                kind, payload = self.msgs.get_nowait()
                if kind == "log":
                    self._append(payload)
                elif kind == "progress":
                    done, total = payload
                    self.progress["maximum"] = max(total, 1)
                    self.progress["value"] = done
                elif kind in ("done", "error"):
                    self.start_btn["state"], self.stop_btn["state"] = "normal", "disabled"
                    if self.log_file:
                        self.log_file.close()
                        self.log_file = None
                    if kind == "done" and payload:
                        self.last_folder = payload
                        messagebox.showinfo(APP_TITLE, f"완료했습니다.\n{payload}")
                    elif kind == "error":
                        messagebox.showerror(APP_TITLE, payload + "\n\n저장 폴더의 _로그 파일과 _진단 폴더를 전달해 주세요.")
        except queue.Empty:
            pass
        self.root.after(100, self._pump)

    def _append(self, text):
        self.logbox["state"] = "normal"
        self.logbox.insert("end", text + "\n")
        self.logbox.see("end")
        self.logbox["state"] = "disabled"
        if self.log_file:
            self.log_file.write(text + "\n")
            self.log_file.flush()

    def _on_close(self):
        if self.worker and self.worker.is_alive():
            if not messagebox.askyesno(APP_TITLE, "작업 중입니다. 종료할까요?"):
                return
            self.stop_event.set()
        self.root.destroy()


def selftest():
    """빌드 점검용: exe 안에서 Edge/Chrome을 실제로 띄울 수 있는지 확인한다."""
    from playwright.sync_api import sync_playwright

    from ppd.job import BROWSER_CHANNELS
    out = os.path.join(os.path.dirname(os.path.abspath(sys.executable)), "selftest.txt")
    lines, ok = [], False
    with sync_playwright() as pw:
        for ch in BROWSER_CHANNELS:
            try:
                b = pw.chromium.launch(channel=ch, headless=True)
                page = b.new_page()
                page.set_content("<title>ok</title>")
                lines.append(f"{ch}: OK ({page.title()})")
                b.close()
                ok = True
                break
            except Exception as e:  # noqa: BLE001
                lines.append(f"{ch}: FAIL {str(e).splitlines()[0]}")
    try:  # 창 화면이 오류 없이 만들어지는지도 확인
        root = tk.Tk()
        App(root)
        root.update()
        root.destroy()
        lines.append("gui: OK")
    except Exception as e:  # noqa: BLE001
        lines.append(f"gui: FAIL {e}")
        ok = False
    with open(out, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    sys.exit(0 if ok else 1)


def main():
    if "--selftest" in sys.argv:
        selftest()
    root = tk.Tk()
    try:
        ttk.Style().theme_use("vista" if sys.platform.startswith("win") else "clam")
    except tk.TclError:
        pass
    App(root)
    root.mainloop()


if __name__ == "__main__":
    main()
