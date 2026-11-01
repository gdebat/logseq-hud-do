export const statuses = ['TODO', 'DOING'];
export const sections = ['today', 'overdue', 'upcoming'];
export const priorities = {A: ['High', 'high'], B: ['Medium', 'medium'], C: ['Low', 'low']};

export function backendArguments(directory, graphs, horizon) {
    if (!graphs.length)
        throw new Error('Add a Logseq graph in Preferences.');
    const args = ['python3', '-m', 'logseq_hud_do', '--horizon', String(horizon)];
    for (const [path, name] of graphs) {
        if (!path.startsWith('/'))
            throw new Error('Graph directories must be absolute paths.');
        args.push(`--graph=${path}`, `--graph-name=${name || path.split('/').filter(Boolean).pop()}`);
    }
    return {args, directory};
}

export function parseTasks(stdout) {
    const data = JSON.parse(stdout);
    for (const section of sections) {
        if (!Array.isArray(data[section]))
            throw new Error('Invalid backend response.');
        for (const task of data[section]) {
            if (typeof task.content !== 'string' || typeof task.graph !== 'string' ||
                typeof task.source_page !== 'string' ||
                typeof task.graph_path !== 'string' || !task.graph_path.startsWith('/') ||
                !statuses.includes(task.status) ||
                (task.priority !== null && !Object.hasOwn(priorities, task.priority)) ||
                (task.scheduled !== null && typeof task.scheduled !== 'string') ||
                (task.deep_link !== null && typeof task.deep_link !== 'string'))
                throw new Error('Invalid backend task.');
        }
    }
    return data;
}

export const defaultBlockFilters = [[':LOGBOOK:', ':END:']];

export const defaultTextFilters = ['^[ \t]*relay-id::'];

// Anchoring and a single repetition keep matching linear in the line length.
export function compileTextFilter(pattern) {
    if (pattern.length > 256 || !pattern.startsWith('^'))
        throw new Error('Use ^ at the start and at most 256 characters.');
    let repetitions = 0;
    for (let i = 1; i < pattern.length; i++) {
        const char = pattern[i];
        if (char === '\\') {
            if (!pattern[++i] || !'dDsSwW\\.^$*+?()[]{}|-'.includes(pattern[i]))
                throw new Error('Unsupported escape.');
        } else if (char === '[') {
            const start = ++i;
            while (i < pattern.length && pattern[i] !== ']') {
                if (pattern[i] === '\\') i++;
                i++;
            }
            if (i === start || i === pattern.length)
                throw new Error('Invalid character class.');
        } else if ('*+'.includes(char)) {
            if (++repetitions > 1)
                throw new Error('Use at most one * or + repetition.');
        } else if ('(){}|?^'.includes(char)) {
            throw new Error('Groups, alternatives, counts and optional matches are unsupported.');
        }
    }
    return new RegExp(pattern);
}

function filterBlocks(lines, blocks) {
    const endings = new Map();
    for (const [start, end] of blocks) {
        if (start.trim() && end.trim() && !endings.has(start.trim()))
            endings.set(start.trim(), end.trim());
    }
    const result = [];
    let opening = -1;
    let closing = null;
    for (let i = 0; i < lines.length; i++) {
        const marker = lines[i].trim();
        if (opening >= 0) {
            if (marker === closing) {
                opening = -1;
                closing = null;
            }
        } else if (endings.has(marker)) {
            opening = i;
            closing = endings.get(marker);
        } else {
            result.push(lines[i]);
        }
    }
    if (opening >= 0)
        for (let i = opening; i < lines.length; i++)
            result.push(lines[i]);
    return result;
}

export function displayContent(content, patterns = defaultTextFilters, blocks = defaultBlockFilters) {
    const filters = patterns.flatMap(pattern => {
        try { return [compileTextFilter(pattern)]; } catch { return []; }
    });
    return filterBlocks(content.split(/\r?\n/), blocks).filter(line => !filters.some(filter => filter.test(line)))
        .join('\n').replace(/\[#(?:A|B|C)\][ \t]*/g, '').trim();
}

export function taskPresentation(task, patterns = defaultTextFilters, blocks = defaultBlockFilters) {
    const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun',
        'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
    const scheduled = task.scheduled ? task.scheduled.split('-') : null;
    const context = scheduled
        ? `${task.graph} · ${Number(scheduled[2])} ${months[Number(scheduled[1]) - 1]} ${scheduled[0]}`
        : task.graph;
    return {
        content: displayContent(task.content, patterns, blocks),
        doing: task.status === 'DOING',
        priority: priorities[task.priority] ?? null,
        context,
        uri: typeof task.deep_link === 'string' && task.deep_link.startsWith('logseq://graph/')
            ? task.deep_link : null,
    };
}

// A settings change during a scan must get a fresh scan after that process exits.
export class RefreshController {
    constructor(run, publish, fail) {
        this.run = run;
        this.publish = publish;
        this.fail = fail;
        this.active = false;
        this.pending = false;
        this.closed = false;
    }

    async refresh(invalidate = false) {
        if (this.closed)
            return;
        if (this.active) {
            this.pending = true;
            this.obsolete ||= invalidate;
            return;
        }
        this.active = true;
        this.obsolete = false;
        try {
            const data = await this.run();
            if (!this.closed && !this.obsolete)
                this.publish(data);
        } catch (error) {
            if (!this.closed && !this.obsolete)
                this.fail(error.message);
        } finally {
            this.active = false;
            if (this.pending && !this.closed) {
                this.pending = false;
                this.refresh();
            }
        }
    }

    close() {
        this.closed = true;
        this.pending = false;
    }
}

export function logicalIdentity(task) {
    if (typeof task.graph_path !== 'string' || !task.graph_path.startsWith('/'))
        throw new Error('Missing stable graph identity.');
    const text = task.content.replace(/\[#(?:A|B|C)\]/g, '').split(/\r?\n/)
        .map(line => line.replace(/[ \t]+/g, ' ').trim()).join('\n').trim();
    return JSON.stringify([task.graph_path, task.source_page, text, task.scheduled]);
}

export function readHidden(settings) {
    const registry = JSON.parse(settings.get_string('hidden-tasks-v2'));
    if (registry.version !== 2 || !Array.isArray(registry.tasks))
        throw new Error('Unsupported hidden task registry.');
    return registry.tasks;
}

export function writeHidden(settings, tasks) {
    settings.set_string('hidden-tasks-v2', JSON.stringify({version: 2, tasks}));
}

export function hideTask(settings, task) {
    const key = logicalIdentity(task);
    const tasks = readHidden(settings).filter(record => record.key !== key);
    tasks.push({key, description: JSON.parse(key)[2], graph: task.graph, scheduled: task.scheduled});
    writeHidden(settings, tasks);
}

export function visibleTasks(data, settings) {
    const hidden = new Set(readHidden(settings).map(record => record.key));
    return Object.fromEntries(sections.map(section => [section,
        data[section].filter(task => !hidden.has(logicalIdentity(task)))]));
}
