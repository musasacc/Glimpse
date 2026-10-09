"""A small todo list in the terminal, built with Textual.

Run it with `pip install -r requirements.txt` and then `python3 app.py`.
Its layout is described for Glimpse in glimpse.scene.json, next to this file.
"""

from dataclasses import dataclass

from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.widgets import Button, Footer, Header, Input, Label, ListItem, ListView, Static


@dataclass
class Todo:
    title: str
    notes: str = ""
    done: bool = False


TODOS = [
    Todo("Buy groceries", "Milk, eggs, bread and coffee beans."),
    Todo("Write the weekly report", "Summarize the release and the open bugs."),
    Todo("Call the plumber", "The kitchen tap is dripping again."),
    Todo("Book train tickets", "Friday evening, two seats by the window.", done=True),
]


class TodoApp(App):
    TITLE = "Todo"
    CSS = """
    #main { height: 1fr; }
    #todos { width: 32; border: round $accent; }
    #details { width: 1fr; border: round $secondary; padding: 0 1; }
    #detail-title { text-style: bold; }
    #detail-notes { height: 1fr; color: $text-muted; }
    #detail-actions { height: 3; }
    #detail-actions Button { margin-right: 1; }
    #new-row { height: 3; }
    #new-todo { width: 1fr; }
    """
    BINDINGS = [
        ("a", "focus_input", "Add"),
        ("d", "toggle_done", "Done"),
        ("q", "quit", "Quit"),
    ]

    def __init__(self) -> None:
        super().__init__()
        self.todos = list(TODOS)

    def compose(self) -> ComposeResult:
        yield Header()
        with Horizontal(id="main"):
            yield ListView(*[ListItem(Label(self.label(todo))) for todo in self.todos], id="todos")
            with Vertical(id="details"):
                yield Static(id="detail-title")
                yield Static(id="detail-notes")
                yield Label(id="detail-status")
                with Horizontal(id="detail-actions"):
                    yield Button("Mark done", id="done", variant="success")
                    yield Button("Delete", id="delete", variant="error")
        with Horizontal(id="new-row"):
            yield Input(placeholder="What needs doing?", id="new-todo")
            yield Button("Add", id="add", variant="primary")
        yield Footer()

    @staticmethod
    def label(todo: Todo) -> str:
        return f"{'✔' if todo.done else '○'} {todo.title}"

    @property
    def current(self) -> int | None:
        return self.query_one("#todos", ListView).index

    def on_mount(self) -> None:
        self.query_one("#todos", ListView).index = 0
        self.show_details()

    def show_details(self) -> None:
        index = self.current
        todo = self.todos[index] if index is not None and index < len(self.todos) else None
        self.query_one("#detail-title", Static).update(todo.title if todo else "Nothing to do")
        self.query_one("#detail-notes", Static).update(todo.notes if todo else "Add a task below.")
        self.query_one("#detail-status", Label).update(f"Status: {'done' if todo and todo.done else 'open'}")
        self.query_one("#done", Button).label = "Mark open" if todo and todo.done else "Mark done"

    def on_list_view_highlighted(self, event: ListView.Highlighted) -> None:
        self.show_details()

    def on_button_pressed(self, event: Button.Pressed) -> None:
        if event.button.id == "add":
            self.add_todo()
        elif event.button.id == "done":
            self.action_toggle_done()
        elif event.button.id == "delete":
            self.delete_todo()

    def on_input_submitted(self, event: Input.Submitted) -> None:
        self.add_todo()

    def action_focus_input(self) -> None:
        self.query_one("#new-todo", Input).focus()

    def action_toggle_done(self) -> None:
        index = self.current
        if index is None:
            return
        todo = self.todos[index]
        todo.done = not todo.done
        list_view = self.query_one("#todos", ListView)
        list_view.children[index].query_one(Label).update(self.label(todo))
        self.show_details()

    def add_todo(self) -> None:
        field = self.query_one("#new-todo", Input)
        title = field.value.strip()
        if not title:
            return
        todo = Todo(title)
        self.todos.append(todo)
        list_view = self.query_one("#todos", ListView)
        list_view.append(ListItem(Label(self.label(todo))))
        list_view.index = len(self.todos) - 1
        field.value = ""

    def delete_todo(self) -> None:
        index = self.current
        if index is None:
            return
        del self.todos[index]
        list_view = self.query_one("#todos", ListView)
        list_view.children[index].remove()
        list_view.index = min(index, len(self.todos) - 1) if self.todos else None
        self.show_details()


if __name__ == "__main__":
    TodoApp().run()
