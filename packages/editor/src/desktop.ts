/**
 * Inside the desktop app the editor is loaded as `/?desktop=mac|win|linux`.
 * Mark <html> before the first paint, so styles.css can make room for the
 * macOS traffic lights from the start. (Once the DOM is ready the app sets the
 * same attribute itself, plus `data-glimpse-fullscreen` while in full screen.)
 */
const desktop = new URLSearchParams(location.search).get("desktop");
if (desktop === "mac" || desktop === "win" || desktop === "linux") document.documentElement.setAttribute("data-glimpse-desktop", desktop);
