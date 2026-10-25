// ChapterBreak («Новая глава»): closes the current chapter and continues the story in a fresh chat.
import { doNewChat } from '../../../../script.js';

const MODULE = 'chapterbreak';
const SC = 'summaryception';
const STATE_TITLE = 'Текущее состояние';
const AN_KEYS = ['note_prompt', 'note_interval', 'note_depth', 'note_position', 'note_role'];

const DEFAULT_PROMPT = `[Pause the roleplay. Do not continue the story. Write an archive recap of the story so far.]
Write it in the same language the story is written in. Use these sections:
1. Scene: where and when the story is right now, what is happening at this moment.
2. Characters: for each important character, their current physical and emotional state, clothing or appearance if relevant, and goals.
3. Relationships: how the characters feel about each other and about {{user}} now.
4. Key events of this chapter, in order.
5. Open threads: unresolved conflicts, promises, plans and mysteries.
Be concrete and use names. Keep it compact: at most 700 words. No roleplay prose, no commentary.
On the very last line write: KEYWORDS: 5-10 comma-separated keywords specific to this chapter (places, objects, events, minor characters). Do not use the names of the main characters, they appear in every chapter.`;

const defaults = { messagesToCopy: 6, recapPrompt: DEFAULT_PROMPT };
const STEPS = ['Сводка Summaryception', 'Пересказ главы', 'Хроника', 'Новый чат', 'Перенос сообщений'];

let running = false;

const ctx = () => SillyTavern.getContext();
const sleep = ms => new Promise(r => setTimeout(r, ms));

// Only the user's own changes are stored, so an improved default prompt reaches everyone who never edited it.
const stored = () => (ctx().extensionSettings[MODULE] ??= {});
const settings = () => ({ ...defaults, ...stored() });
function store(key, value) {
    if (value === defaults[key]) delete stored()[key]; else stored()[key] = value;
    ctx().saveSettingsDebounced();
}

// ─── Progress modal ──────────────────────────────────────────────────

function openModal() {
    $('#cb_overlay').remove();
    const rows = STEPS.map((s, i) => `<li data-step="${i}"><span class="cb-icon">○</span> ${s}<div class="cb-detail"></div></li>`).join('');
    $('body').append(`
        <div id="cb_overlay"><div class="cb-modal">
            <h3>📖 Новая глава</h3>
            <div class="cb-bar"><div class="cb-bar-fill"></div></div>
            <ol class="cb-steps">${rows}</ol>
            <div class="cb-messages"></div>
            <div class="cb-buttons">
                <div class="menu_button cb-retry" style="display:none">Повторить</div>
                <div class="menu_button cb-close" style="display:none">Закрыть</div>
            </div>
        </div></div>`);
    $('#cb_overlay .cb-close').on('click', () => $('#cb_overlay').remove());
    $('#cb_overlay .cb-retry').on('click', () => { $('#cb_overlay').remove(); runChapterBreak(); });
}

function step(i, state, detail) {
    const li = $(`#cb_overlay li[data-step="${i}"]`);
    li.attr('class', `cb-${state}`).find('.cb-icon').text({ active: '⏳', done: '✓', error: '✗', skip: '–' }[state]);
    if (detail !== undefined) li.find('.cb-detail').text(detail);
    const done = state === 'done' || state === 'skip' ? i + 1 : i;
    $('#cb_overlay .cb-bar-fill').css('width', `${Math.round(done / STEPS.length * 100)}%`);
}

function note(text, kind = 'warn') {
    $('#cb_overlay .cb-messages').append($(`<div class="cb-msg-${kind}"></div>`).text(text));
}

function finish({ retry = false } = {}) {
    $('#cb_overlay .cb-close').show();
    $('#cb_overlay .cb-retry').toggle(retry);
}

// ─── Step 1: Summaryception catch-up ─────────────────────────────────

function scActive() {
    const s = ctx().extensionSettings[SC];
    return !!(s && s.enabled && $('#sc_force_summarize').length);
}

const isTurn = m => !m.is_user && !m.is_system && m.mes?.trim();

// Clicks Summaryception's own "Force Summarize" and waits until it finishes.
async function scForce(onTick) {
    const btn = $('#sc_force_summarize');
    btn.trigger('click');
    while (btn.prop('disabled')) {
        onTick();
        await sleep(500);
    }
}

// Summarizes every assistant turn before copyStart, without touching the turns that will be copied.
async function catchUpSummaryception(copyStart) {
    const { chat, chatMetadata, extensionSettings } = ctx();
    const s = extensionSettings[SC];
    const visible = chat.map((m, i) => (isTurn(m) && !m.extra?.sc_ghosted ? i : -1)).filter(i => i >= 0);
    const keep = visible.filter(i => i >= copyStart).length;
    const todo = visible.length - keep;
    if (todo <= 0) return 'нечего досводить';

    const saved = { verbatimTurns: s.verbatimTurns, turnsPerSummary: s.turnsPerSummary };
    const tps = Math.max(1, saved.turnsPerSummary || 1);
    const rest = todo % tps;
    const tick = () => {
        const left = ctx().chat.filter((m, i) => i < copyStart && isTurn(m) && !m.extra?.sc_ghosted).length;
        step(0, 'active', `осталось ходов: ${left} из ${todo}`);
    };
    try {
        // Full batches first, then one smaller batch for the remainder, so no batch spills into the copied turns.
        if (todo >= tps) {
            s.verbatimTurns = keep + rest;
            await scForce(tick);
        }
        if (rest > 0) {
            s.verbatimTurns = keep;
            s.turnsPerSummary = rest;
            await scForce(tick);
        }
    } finally {
        Object.assign(s, saved);
    }
    const left = ctx().chat.filter((m, i) => i < copyStart && isTurn(m) && !m.extra?.sc_ghosted).length;
    if (left > 0) throw new Error(`Summaryception не досводил ${left} ход(ов) — проверьте его подключение к модели.`);
    return `сведено ходов: ${todo}, всё до индекса ${chatMetadata[SC]?.summarizedUpTo}`;
}

// ─── Step 2: recap ───────────────────────────────────────────────────

async function generateRecap() {
    if (ctx().onlineStatus === 'no_connection') throw new Error('Нет подключения к модели: откройте API Connections и нажмите Connect.');
    const raw = await ctx().generateQuietPrompt({ quietPrompt: settings().recapPrompt });
    const text = String(raw ?? '').trim();
    if (!text) throw new Error('Модель вернула пустой ответ.');
    const m = text.match(/^[\s*#_>-]*(?:KEYWORDS|Ключевые слова)[\s*_]*:[\s*_]*(.+)$/im);
    const keywords = m ? m[1].split(/[,;]/).map(k => k.replace(/[*_]/g, '').trim().replace(/\.$/, '')).filter(Boolean) : [];
    const recap = m ? text.replace(m[0], '').trim() : text;
    return { recap, keywords };
}

// ─── Step 3: Chronicle lorebook ──────────────────────────────────────

async function writeChronicle(bookName, chapter, recap, keywords) {
    const c = ctx();
    if (!c.getWorldInfoNames().includes(bookName)) {
        await c.saveWorldInfo(bookName, { entries: {} }, true);
        await c.updateWorldInfoList();
    }
    const data = await c.loadWorldInfo(bookName) ?? { entries: {} };
    data.entries ??= {};
    const upsert = (comment, fields) => {
        let entry = Object.values(data.entries).find(e => e.comment === comment);
        if (!entry) {
            const uid = Math.max(-1, ...Object.keys(data.entries).map(Number)) + 1;
            entry = { uid, key: [], keysecondary: [], selective: true, selectiveLogic: 0, addMemo: true, disable: false,
                position: 0, depth: 4, probability: 100, useProbability: true, excludeRecursion: false, preventRecursion: false,
                displayIndex: uid };
            data.entries[uid] = entry;
        }
        Object.assign(entry, { comment }, fields);
    };
    upsert(`Глава ${chapter}`, { content: `Глава ${chapter}\n${recap}`, key: [`Глава ${chapter}`, ...keywords], constant: false, order: 100 + chapter });
    upsert(STATE_TITLE, { content: `[Состояние истории после главы ${chapter}]\n${recap}`, key: [], constant: true, order: 99 });
    await c.saveWorldInfo(bookName, data, true);
}

// ─── Main flow ───────────────────────────────────────────────────────

async function runChapterBreak() {
    if (running) return;
    const c = ctx();
    if (c.groupId) return toastr.warning('«Новая глава» работает только в чате с одним персонажем, не в групповом.');
    if (c.characterId === undefined || !c.chat?.length) return toastr.warning('Откройте чат с персонажем.');

    running = true;
    openModal();
    let current = 0;
    try {
        const { chat, chatMetadata, characterId } = c;
        const charName = c.characters[characterId].name;
        const oldChatId = c.getCurrentChatId();
        const bookName = `${charName} — Хроника`.replace(/[\\/:*?"<>|]/g, '');
        const chapter = (chatMetadata[MODULE]?.chapter ?? 0) + 1;
        const n = Math.max(1, Number(settings().messagesToCopy) || 6);
        let copyStart = Math.max(0, chat.length - n);

        // 1. Summaryception
        const sc = scActive();
        if (sc) {
            step(0, 'active');
            step(0, 'done', await catchUpSummaryception(copyStart));
            // Pull in user messages between the last summarized turn and the copy window, so nothing is lost.
            const upTo = c.chatMetadata[SC]?.summarizedUpTo ?? -1;
            while (copyStart > upTo + 1 && !isTurn(chat[copyStart - 1])) copyStart--;
        } else {
            step(0, 'skip', 'нет или выключен');
            note('Summaryception не найден или выключен: память глав не переносится, пересказ строится только по самому чату.');
        }

        // 2. Recap
        current = 1;
        step(1, 'active', 'генерирует текущая модель…');
        let recap, keywords;
        try {
            ({ recap, keywords } = await generateRecap());
        } catch (e) {
            step(1, 'error', e?.message || String(e));
            note('Ничего не создано, старый чат не изменён. Можно повторить.', 'error');
            return finish({ retry: true });
        }
        step(1, 'done', `${recap.length} знаков`);

        // 3. Chronicle
        current = 2;
        step(2, 'active');
        await writeChronicle(bookName, chapter, recap, keywords);
        step(2, 'done', `«${bookName}»: Глава ${chapter} + ${STATE_TITLE}`);
        if (chatMetadata.world_info && chatMetadata.world_info !== bookName) {
            note(`У старого чата был свой лорбук «${chatMetadata.world_info}». В новом чате к чату привязана Хроника (у чата может быть только один лорбук).`);
        }

        // Collect everything to carry before switching chats.
        const messages = chat.slice(copyStart).map(m => {
            const copy = structuredClone(m);
            if (copy.extra?.sc_ghosted) { delete copy.extra.sc_ghosted; copy.is_system = false; }
            return copy;
        });
        const carry = { world_info: bookName, [MODULE]: { chapter, previousChat: oldChatId } };
        for (const k of AN_KEYS) if (chatMetadata[k] !== undefined) carry[k] = structuredClone(chatMetadata[k]);
        if (chatMetadata.variables) carry.variables = structuredClone(chatMetadata.variables);
        if (chatMetadata[SC]?.layers) {
            const layers = structuredClone(chatMetadata[SC].layers);
            // Old indices mean nothing in the new chat: drop them so Summaryception starts counting from 0.
            for (const layer of layers) for (const sn of layer ?? []) delete sn.turnRange;
            carry[SC] = { layers, summarizedUpTo: -1, ghostedIndices: [] };
        }

        // 4. New chat
        current = 3;
        step(3, 'active');
        await doNewChat({ deleteCurrentChat: false });
        const c2 = ctx();
        if (c2.characterId !== characterId || c2.getCurrentChatId() === oldChatId) throw new Error('Не удалось создать новый чат.');
        // Let Summaryception finish reacting to the empty new chat first. Otherwise it caches the carried
        // summary as "already injected" and skips it after the reload below.
        await sleep(1500);
        Object.assign(c2.chatMetadata, carry);
        step(3, 'done', c2.getCurrentChatId());

        // 5. Messages (replace the auto greeting)
        current = 4;
        step(4, 'active');
        c2.chat.splice(0, c2.chat.length, ...messages);
        await c2.saveChat();
        await c2.reloadCurrentChat();
        step(4, 'done', `скопировано сообщений: ${messages.length}`);
        if (carry[SC] && scActive()) {
            await sleep(1500);
            if (!ctx().extensionPrompts[SC]?.value) note('Summaryception пока не подхватил память: откройте старый чат и вернитесь в этот.');
        }
        note(`Глава ${chapter} закрыта. Старый чат «${oldChatId}» остался без изменений.`, 'ok');
        finish();
    } catch (e) {
        console.error('[ChapterBreak]', e);
        step(current, 'error', e?.message || String(e));
        note('Процесс остановлен. Старый чат не изменён.', 'error');
        finish({ retry: current < 3 });
    } finally {
        running = false;
    }
}

// ─── UI ──────────────────────────────────────────────────────────────

function addSettingsPanel() {
    const s = settings();
    $('#extensions_settings2').append(`
        <div class="inline-drawer">
            <div class="inline-drawer-toggle inline-drawer-header"><b>Новая глава</b><div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div></div>
            <div class="inline-drawer-content">
                <label for="cb_count">Сколько последних сообщений переносить</label>
                <input id="cb_count" class="text_pole" type="number" min="1" max="50">
                <label for="cb_prompt">Запрос на пересказ главы</label>
                <textarea id="cb_prompt" class="text_pole" rows="10"></textarea>
                <div id="cb_reset" class="menu_button">Вернуть запрос по умолчанию</div>
            </div>
        </div>`);
    $('#cb_count').val(s.messagesToCopy).on('input', function () { store('messagesToCopy', Number(this.value) || defaults.messagesToCopy); });
    $('#cb_prompt').val(s.recapPrompt).on('input', function () { store('recapPrompt', this.value); });
    $('#cb_reset').on('click', () => { store('recapPrompt', DEFAULT_PROMPT); $('#cb_prompt').val(DEFAULT_PROMPT); });
}

jQuery(() => {
    addSettingsPanel();
    $('#extensionsMenu').append(`<div id="cb_wand" class="list-group-item flex-container flexGap5"><div class="fa-solid fa-book-bookmark extensionsMenuExtensionButton"></div><span>Новая глава</span></div>`);
    $('#cb_wand').on('click', () => runChapterBreak());

    const { SlashCommandParser, SlashCommand } = ctx();
    SlashCommandParser.addCommandObject(SlashCommand.fromProps({
        name: 'nextchapter',
        callback: async () => { await runChapterBreak(); return ''; },
        helpString: 'Новая глава: пересказ в лорбук «Хроника», новый чат с памятью Summaryception и последними сообщениями.',
    }));
});
