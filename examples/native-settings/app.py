"""A settings window built with Tkinter, Python's built-in GUI toolkit.

Run it with `python app.py` (no packages needed; on Linux you may need the
python3-tk package). Its layout is described for Glimpse in glimpse.scene.json.
"""

import json
import tkinter as tk
from tkinter import ttk

SECTIONS = ["General", "Appearance", "Notifications", "Privacy", "Advanced"]
LANGUAGES = ["English", "Deutsch", "Español", "Français", "日本語"]


class SettingsWindow(tk.Tk):
    def __init__(self) -> None:
        super().__init__()
        self.title("Settings")
        self.geometry("640x440")
        self.resizable(False, False)

        self.name = tk.StringVar(value="Ada Lovelace")
        self.email = tk.StringVar(value="ada@example.com")
        self.language = tk.StringVar(value=LANGUAGES[0])
        self.open_at_login = tk.BooleanVar(value=True)
        self.check_updates = tk.BooleanVar(value=True)
        self.send_usage = tk.BooleanVar(value=False)

        # Sidebar with the sections, on the left.
        sidebar = ttk.Frame(self, width=160)
        sidebar.pack(side="left", fill="y")
        sidebar.pack_propagate(False)
        self.sections = tk.Listbox(sidebar, activestyle="none", borderwidth=0, highlightthickness=0, exportselection=False)
        for name in SECTIONS:
            self.sections.insert("end", name)
        self.sections.selection_set(0)
        self.sections.bind("<<ListboxSelect>>", self.on_section)
        self.sections.pack(fill="both", expand=True, padx=8, pady=8)

        ttk.Separator(self, orient="vertical").pack(side="left", fill="y")

        # The form for the selected section.
        content = ttk.Frame(self, padding=(24, 20))
        content.pack(side="left", fill="both", expand=True)
        content.columnconfigure(1, weight=1)
        content.rowconfigure(7, weight=1)

        self.heading = ttk.Label(content, text="General", font=("TkDefaultFont", 16, "bold"))
        self.heading.grid(row=0, column=0, columnspan=2, sticky="w", pady=(0, 16))

        ttk.Label(content, text="Display name").grid(row=1, column=0, sticky="w", padx=(0, 12), pady=6)
        name_entry = ttk.Entry(content, textvariable=self.name)
        name_entry.grid(row=1, column=1, sticky="ew", pady=6)

        ttk.Label(content, text="Email").grid(row=2, column=0, sticky="w", padx=(0, 12), pady=6)
        email_entry = ttk.Entry(content, textvariable=self.email)
        email_entry.grid(row=2, column=1, sticky="ew", pady=6)

        ttk.Label(content, text="Language").grid(row=3, column=0, sticky="w", padx=(0, 12), pady=6)
        language = ttk.Combobox(content, textvariable=self.language, values=LANGUAGES, state="readonly")
        language.grid(row=3, column=1, sticky="ew", pady=6)

        login = ttk.Checkbutton(content, text="Open at login", variable=self.open_at_login)
        login.grid(row=4, column=1, sticky="w", pady=6)
        updates = ttk.Checkbutton(content, text="Check for updates automatically", variable=self.check_updates)
        updates.grid(row=5, column=1, sticky="w", pady=6)
        usage = ttk.Checkbutton(content, text="Send anonymous usage statistics", variable=self.send_usage)
        usage.grid(row=6, column=1, sticky="w", pady=6)

        # Save and Cancel, bottom right.
        buttons = ttk.Frame(content)
        buttons.grid(row=8, column=0, columnspan=2, sticky="e")
        save = ttk.Button(buttons, text="Save", default="active", command=self.save)
        save.pack(side="right")
        cancel = ttk.Button(buttons, text="Cancel", command=self.destroy)
        cancel.pack(side="right", padx=(0, 8))

        self.bind("<Return>", lambda _event: self.save())
        self.bind("<Escape>", lambda _event: self.destroy())

    def on_section(self, _event: tk.Event) -> None:
        selected = self.sections.curselection()
        if selected:
            self.heading.configure(text=SECTIONS[selected[0]])

    def save(self) -> None:
        settings = {
            "name": self.name.get(),
            "email": self.email.get(),
            "language": self.language.get(),
            "open_at_login": self.open_at_login.get(),
            "check_updates": self.check_updates.get(),
            "send_usage": self.send_usage.get(),
        }
        print(json.dumps(settings, ensure_ascii=False))
        self.destroy()


if __name__ == "__main__":
    SettingsWindow().mainloop()
