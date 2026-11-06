// Exercise the production positioning method with real GJS Graphene values.
// Actor sizing remains a double; this is not a live Shell layout test.
import Gio from 'gi://Gio';
import Graphene from 'gi://Graphene';

const [, bytes] = Gio.File.new_for_path('extension/extension.js').load_contents(null);
const source = new TextDecoder().decode(bytes);
const method = source.match(/    _positionPopup\(preview, box\) \{[\s\S]*?\n    \}/)[0];
let area = {x: 0, y: 24, width: 1920, height: 1056};
const Main = {layoutManager: {
    primaryMonitor: {index: 0}, findMonitorForActor: () => null,
    getWorkAreaForMonitor: () => area,
}};
const St = {ThemeContext: {get_for_stage: () => ({scale_factor: 1})}};
const position = new Function('Main', 'St', 'global', `return ({${method}});`)(Main, St, {stage: {}});
function check(x, y, width, height) {
    const rect = new Graphene.Rect();
    rect.init(x, y, 16, 16);
    const box = {
        get_preferred_width: () => [0, width], get_preferred_height: () => [0, height],
        set_width(w) { this.width = w; }, set_height(h) { this.height = h; },
        set_position(px, py) { this.x = px; this.y = py; },
    };
    position._positionPopup({get_transformed_extents: () => rect}, box);
    if (box.x < area.x || box.y < area.y || box.x + box.width > area.x + area.width ||
        box.y + box.height > area.y + area.height)
        throw new Error(`Outside work area: ${JSON.stringify(box)}`);
    return box;
}
if (check(100, 50, 200, 120).y !== 70)
    throw new Error('Expected placement below button');
check(1900, 1050, 200, 120);
check(600, 500, 5000, 10000);
area = {x: -1280, y: 100, width: 1280, height: 720};
check(-20, 800, 5000, 10000);
print('Real Graphene popup positioning passed');
