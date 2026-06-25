#include <pebble.h>

// Uncomment to seed sample history/reminders + a DOWN-button hook that opens the
// DUMPED success screen — lets the emulator render every screen without a phone.
// MUST stay commented for release builds.
// #define DEBUG_SEED 1

// ============================================================================
// CONSTANTS
// ============================================================================

#define NOTE_BUF_SIZE      400
#define STATUS_BUF_SIZE     48
#define CONV_BUF_SIZE     1200
#define MAX_HISTORY          8
#define HISTORY_SHORT_LEN   48
#define HISTORY_FULL_LEN   600   // stores full conversation thread

// Persistent storage keys
//
// Pebble caps each persist value at 256 bytes, so a history entry can't be one
// blob (short+full+dest+ts ≈ 653 B — the tail fields silently fail to write).
// We split it: a small meta record (short+dest+ts, ~53 B) per slot, plus the
// full transcript chunked across HISTORY_FULL_CHUNKS string keys.
#define PERSIST_HISTORY_VERSION_KEY  0
#define PERSIST_HISTORY_VERSION      4   // bump when layout changes (was 3: oversized blob)
#define PERSIST_HISTORY_COUNT        1
#define PERSIST_HISTORY_BASE        10   // meta records at 10..17
#define HISTORY_FULL_CHUNK         200   // bytes per full-text chunk (< 256 persist cap)
#define HISTORY_FULL_CHUNKS          3   // 3 × 200 = 600 = HISTORY_FULL_LEN
#define PERSIST_HIST_FULL_BASE     100   // chunk c of slot s at 100 + s*CHUNKS + c

// Reminders (local storage, always available)
#define MAX_REMINDERS       16
#define REMINDER_TEXT_LEN  200
#define PERSIST_REM_COUNT    4
#define PERSIST_REM_BASE    30   // entries at 30..45

// Destination indices (must match pkjs)
#define DEST_TASKS   0
#define DEST_NOTION  1
#define DEST_AI      2
#define DEST_WEBHOOK 3
#define DEST_LOCAL   4   // on-watch reminders list (no phone needed)
#define DEST_TODOIST    5
#define DEST_NEXTCLOUD  6

// Destination bitmask bits (must match pkjs DEST_MASK)
#define DEST_BIT_TASKS     (1 << DEST_TASKS)
#define DEST_BIT_NOTION    (1 << DEST_NOTION)
#define DEST_BIT_AI        (1 << DEST_AI)
#define DEST_BIT_WEBHOOK   (1 << DEST_WEBHOOK)
#define DEST_BIT_TODOIST   (1 << DEST_TODOIST)
#define DEST_BIT_NEXTCLOUD (1 << DEST_NEXTCLOUD)

// Ink theme — strict black & white
#define C_SCREEN   GColorBlack
#define C_BAR      GColorWhite
#define C_ON_SCREEN GColorWhite
#define C_ON_BAR   GColorBlack

// Layout chrome (Time 2 handoff spec)
#define STATUS_H       18
#define ACTION_BAR_W   33
#define MENU_ROW_H     44
#define ICON_SIZE      18
#define MENU_TILE_SIZE 24
#define MAX_MERGED     (MAX_HISTORY + MAX_REMINDERS)
#define MERGED_META_LEN 24

// ============================================================================
// DATA TYPES
// ============================================================================

// Small meta record (≤256 B) — full transcript stored separately in chunks.
typedef struct __attribute__((packed)) {
    char     short_text[HISTORY_SHORT_LEN];
    uint8_t  dest;
    uint32_t timestamp;
} HistoryMeta;

typedef struct __attribute__((packed)) {
    char     text[REMINDER_TEXT_LEN];
    uint32_t timestamp;
} ReminderEntry;

// ============================================================================
// GLOBAL STATE
// ============================================================================

// --- Windows ---
static Window *s_home_window;
static Window *s_confirm_window;
static Window *s_response_window;
static Window *s_history_window;
static Window *s_detail_window;
static Window *s_rem_detail_window;
static Window *s_success_window;

// --- Home window layers ---
static Layer       *s_canvas_layer;
static TextLayer   *s_home_title_layer;
static TextLayer   *s_home_clock_layer;
static char         s_clock_buf[8];
static TextLayer   *s_hero_layer;
static TextLayer   *s_meta_layer;

// --- Success ("DUMPED") window ---
static Layer *s_success_canvas_layer;
static int    s_success_dest = DEST_AI;
static char   s_success_quote[64];
static AppTimer *s_success_timer = NULL;

// --- Confirm window ---
static Layer     *s_confirm_canvas_layer;
static TextLayer *s_confirm_title_layer;
static TextLayer *s_confirm_content_layer;
static TextLayer *s_confirm_target_layer;
static bool       s_confirm_is_followup;
static bool       s_confirm_open      = false;
static char       s_confirm_target_buf[32];

// --- Response window layers ---
static TextLayer  *s_resp_header_layer;
static ScrollLayer *s_resp_scroll_layer;
static TextLayer  *s_resp_content_layer;

// --- History window (merged smart actions + local notes) ---
typedef enum { MERGED_SMART = 0, MERGED_LOCAL = 1 } MergedKind;

typedef struct {
    MergedKind kind;
    int        src_idx;
    uint8_t    dest;
    uint32_t   timestamp;
    char       title[HISTORY_SHORT_LEN];
    char       meta[MERGED_META_LEN];
} MergedEntry;

// Custom scrolling list (MenuLayer's highlight compositing proved unreliable
// with full-cell custom drawing, so we render rows ourselves).
static Layer     *s_hist_list_layer;
static int        s_hist_sel    = 0;   // selected row
static int        s_hist_scroll = 0;   // scroll offset in px
static int        s_hist_row_w  = 144;
static TextLayer *s_hist_title_layer;
static MergedEntry s_merged[MAX_MERGED];
static int         s_merged_count = 0;
static TextLayer  *s_hist_empty_label;
static TextLayer  *s_hist_empty_hint;

// --- Detail window layers ---
static TextLayer  *s_detail_header_layer;
static ScrollLayer *s_detail_scroll_layer;
static TextLayer  *s_detail_content_layer;

// --- Dictation ---
static DictationSession *s_dictation_session;

// --- Buffers ---
static char s_note_buf[NOTE_BUF_SIZE];
static char s_ai_response_buf[NOTE_BUF_SIZE];
static char s_status_buf[STATUS_BUF_SIZE];
static char s_conversation_buf[CONV_BUF_SIZE];
static int  s_conv_loading_at = -1;   // offset of "..." in s_conversation_buf

// --- State flags ---
static bool    s_waiting_response   = false;
static bool    s_response_open      = false;
static bool    s_is_followup        = false;
static bool    s_in_ai_thread        = false;
static int     s_dest_mask           = DEST_BIT_AI;   // default until phone responds
static int16_t s_resp_scroll_offset  = 0;
static int16_t s_detail_scroll_offset = 0;

// --- History ---
static int      s_history_count = 0;
static char     s_history_short[MAX_HISTORY][HISTORY_SHORT_LEN];
static char     s_history_full [MAX_HISTORY][HISTORY_FULL_LEN];
static uint8_t  s_history_dest [MAX_HISTORY];
static uint32_t s_history_ts   [MAX_HISTORY];
static int      s_detail_idx    = 0;

// --- Reminders (local storage) ---
static TextLayer *s_rem_detail_header;
static ScrollLayer *s_rem_detail_scroll;
static TextLayer *s_rem_detail_content;
static TextLayer *s_rem_detail_hint;
static int      s_rem_count      = 0;
static char     s_rem_text[MAX_REMINDERS][REMINDER_TEXT_LEN];
static uint32_t s_rem_ts[MAX_REMINDERS];
static int      s_rem_detail_idx = 0;
static bool     s_rem_confirm    = false;
static int16_t  s_rem_scroll_offset = 0;
static char     s_rem_hint_buf[40];
static char     s_rem_header_buf[32];

// ============================================================================
// FORWARD DECLARATIONS
// ============================================================================

static void home_window_push(void);
static void confirm_window_push(void);
static void response_window_push(void);
static void history_window_push(void);
static void detail_window_push(int idx);
static void rem_detail_window_push(int display_idx);
static void merged_rebuild(void);
static void success_window_push(int dest);

// ============================================================================
// HELPERS
// ============================================================================

static const char *dest_short_name(int dest) {
    switch (dest) {
        case DEST_TASKS:   return "Tasks";
        case DEST_NOTION:  return "Notion";
        case DEST_AI:      return "AI";
        case DEST_WEBHOOK: return "Hook";
        case DEST_LOCAL:   return "Local";
        case DEST_TODOIST:   return "Todoist";
        case DEST_NEXTCLOUD: return "Cloud";
        default:           return "?";
    }
}

static const char *dest_meta_name(int dest) {
    switch (dest) {
        case DEST_TASKS:     return "TASKS";
        case DEST_NOTION:    return "NOTION";
        case DEST_AI:        return "AI";
        case DEST_WEBHOOK:   return "HOOK";
        case DEST_LOCAL:     return "NOTE";
        case DEST_TODOIST:   return "TODOIST";
        case DEST_NEXTCLOUD: return "CLOUD";
        default:             return "?";
    }
}

static int content_area_w(GRect bounds) {
    int w = bounds.size.w - ACTION_BAR_W;
    return (w < 20) ? bounds.size.w : w;
}

static int action_bar_x(GRect bounds) {
    return bounds.size.w - ACTION_BAR_W;
}

static int btn_y_at(GRect bounds, int pct) {
    return bounds.size.h * pct / 100;
}

static void format_relative_meta(uint32_t ts, int dest, char *buf, size_t len) {
    const char *name = dest_meta_name(dest);
    uint32_t now = (uint32_t)time(NULL);
    uint32_t diff = (now > ts) ? (now - ts) : 0;
    // "\xC2\xB7" = middot (·) in UTF-8, per handoff meta separator
    if (diff < 60) {
        snprintf(buf, len, "%s \xC2\xB7 NOW", name);
    } else if (diff < 3600) {
        snprintf(buf, len, "%s \xC2\xB7 %luM", name, (unsigned long)(diff / 60));
    } else if (diff < 86400) {
        snprintf(buf, len, "%s \xC2\xB7 %luH", name, (unsigned long)(diff / 3600));
    } else {
        snprintf(buf, len, "%s \xC2\xB7 %luD", name, (unsigned long)(diff / 86400));
    }
}

static void set_status(const char *msg) {
    strncpy(s_status_buf, msg, STATUS_BUF_SIZE - 1);
    s_status_buf[STATUS_BUF_SIZE - 1] = '\0';
    if (!s_hero_layer) return;
    if (strcmp(msg, "Ready") == 0) {
        text_layer_set_text(s_hero_layer, "READY");
        if (s_meta_layer) text_layer_set_text(s_meta_layer, "PRESS TO SPEAK");
    } else {
        text_layer_set_text(s_hero_layer, msg);
        if (s_meta_layer) text_layer_set_text(s_meta_layer, "");
    }
    if (s_canvas_layer) layer_mark_dirty(s_canvas_layer);
}

// ============================================================================
// PERSISTENT HISTORY
// ============================================================================

// Scratch buffers for persist read/write — kept in BSS (not stack) to avoid
// stack overflow. HistoryEntry is 653 bytes; allocating two on the stack
// simultaneously (history_save_item → history_load_from_persist) would consume
// ~1.3 KB of the ~2.5 KB app stack and trigger a hard fault.
static HistoryMeta   s_hist_meta_buf;
static ReminderEntry s_rem_entry_buf;
static char          s_hist_chunk_buf[HISTORY_FULL_CHUNK + 1];

// Write a transcript across HISTORY_FULL_CHUNKS string keys for the given slot.
static void history_write_full(int slot, const char *full) {
    int len = (int)strlen(full);
    for (int c = 0; c < HISTORY_FULL_CHUNKS; c++) {
        uint32_t key = (uint32_t)(PERSIST_HIST_FULL_BASE + slot * HISTORY_FULL_CHUNKS + c);
        int off = c * HISTORY_FULL_CHUNK;
        if (off < len) {
            strncpy(s_hist_chunk_buf, full + off, HISTORY_FULL_CHUNK);
            s_hist_chunk_buf[HISTORY_FULL_CHUNK] = '\0';
        } else {
            s_hist_chunk_buf[0] = '\0';
        }
        persist_write_string(key, s_hist_chunk_buf);
    }
}

// Reassemble a transcript from its chunk keys into dst.
static void history_read_full(int slot, char *dst, int dstlen) {
    dst[0] = '\0';
    int used = 0;
    for (int c = 0; c < HISTORY_FULL_CHUNKS; c++) {
        uint32_t key = (uint32_t)(PERSIST_HIST_FULL_BASE + slot * HISTORY_FULL_CHUNKS + c);
        if (!persist_exists(key)) break;
        int n = persist_read_string(key, s_hist_chunk_buf, sizeof(s_hist_chunk_buf));
        if (n <= 0) break;
        int clen = (int)strlen(s_hist_chunk_buf);
        if (used + clen >= dstlen) clen = dstlen - 1 - used;
        if (clen <= 0) break;
        memcpy(dst + used, s_hist_chunk_buf, clen);
        used += clen;
        dst[used] = '\0';
        if (clen < HISTORY_FULL_CHUNK) break;   // last chunk
    }
}

static void history_load_from_persist(void) {
    // Wipe history if schema version has changed
    if (!persist_exists(PERSIST_HISTORY_VERSION_KEY) ||
        persist_read_int(PERSIST_HISTORY_VERSION_KEY) != PERSIST_HISTORY_VERSION) {
        persist_write_int(PERSIST_HISTORY_VERSION_KEY, PERSIST_HISTORY_VERSION);
        persist_write_int(PERSIST_HISTORY_COUNT, 0);
        s_history_count = 0;
        return;
    }

    int stored = persist_exists(PERSIST_HISTORY_COUNT)
                 ? persist_read_int(PERSIST_HISTORY_COUNT) : 0;
    int n = (stored > MAX_HISTORY) ? MAX_HISTORY : stored;
    s_history_count = 0;

    // Read most-recent first (slot = (stored-1-i) % MAX_HISTORY)
    for (int i = 0; i < n; i++) {
        int slot = ((stored - 1 - i) % MAX_HISTORY + MAX_HISTORY) % MAX_HISTORY;
        uint32_t key = (uint32_t)(PERSIST_HISTORY_BASE + slot);
        if (!persist_exists(key)) continue;
        if (persist_read_data(key, &s_hist_meta_buf, sizeof(s_hist_meta_buf)) < 0) continue;
        strncpy(s_history_short[s_history_count], s_hist_meta_buf.short_text, HISTORY_SHORT_LEN - 1);
        history_read_full(slot, s_history_full[s_history_count], HISTORY_FULL_LEN);
        s_history_dest[s_history_count] = s_hist_meta_buf.dest;
        s_history_ts  [s_history_count] = s_hist_meta_buf.timestamp;
        s_history_count++;
    }
}

// question → short_text (list label); response → full_text (detail view).
// Pass NULL for response to use question as both (non-AI destinations).
static void history_save_item(const char *question, const char *response, int dest) {
    int stored = persist_exists(PERSIST_HISTORY_COUNT)
                 ? persist_read_int(PERSIST_HISTORY_COUNT) : 0;
    int slot = stored % MAX_HISTORY;

    memset(&s_hist_meta_buf, 0, sizeof(s_hist_meta_buf));
    strncpy(s_hist_meta_buf.short_text, question, HISTORY_SHORT_LEN - 1);
    s_hist_meta_buf.dest      = (uint8_t)dest;
    s_hist_meta_buf.timestamp = (uint32_t)time(NULL);

    persist_write_data((uint32_t)(PERSIST_HISTORY_BASE + slot), &s_hist_meta_buf, sizeof(s_hist_meta_buf));
    history_write_full(slot, response ? response : question);
    persist_write_int(PERSIST_HISTORY_COUNT, stored + 1);

    history_load_from_persist();
}

// Update the full_text of the most recently saved entry (for follow-up responses).
static void history_update_latest(const char *response) {
    int stored = persist_exists(PERSIST_HISTORY_COUNT)
                 ? persist_read_int(PERSIST_HISTORY_COUNT) : 0;
    if (stored == 0) return;
    int slot = ((stored - 1) % MAX_HISTORY + MAX_HISTORY) % MAX_HISTORY;
    history_write_full(slot, response);
    // Also update in-memory display (most-recent is at index 0)
    if (s_history_count > 0) {
        strncpy(s_history_full[0], response, HISTORY_FULL_LEN - 1);
        s_history_full[0][HISTORY_FULL_LEN - 1] = '\0';
    }
}

// ============================================================================
// PERSISTENT REMINDERS
// ============================================================================

static void reminders_save_to_persist(void) {
    persist_write_int(PERSIST_REM_COUNT, s_rem_count);
    for (int i = 0; i < s_rem_count; i++) {
        memset(&s_rem_entry_buf, 0, sizeof(s_rem_entry_buf));
        strncpy(s_rem_entry_buf.text, s_rem_text[i], REMINDER_TEXT_LEN - 1);
        s_rem_entry_buf.timestamp = s_rem_ts[i];
        persist_write_data((uint32_t)(PERSIST_REM_BASE + i), &s_rem_entry_buf, sizeof(s_rem_entry_buf));
    }
}

static void reminders_load_from_persist(void) {
    int n = persist_exists(PERSIST_REM_COUNT)
            ? persist_read_int(PERSIST_REM_COUNT) : 0;
    if (n > MAX_REMINDERS) n = MAX_REMINDERS;
    s_rem_count = 0;
    for (int i = 0; i < n; i++) {
        uint32_t key = (uint32_t)(PERSIST_REM_BASE + i);
        if (!persist_exists(key)) continue;
        if (persist_read_data(key, &s_rem_entry_buf, sizeof(s_rem_entry_buf)) < 0) continue;
        strncpy(s_rem_text[s_rem_count], s_rem_entry_buf.text, REMINDER_TEXT_LEN - 1);
        s_rem_ts[s_rem_count] = s_rem_entry_buf.timestamp;
        s_rem_count++;
    }
}

static void reminders_add(const char *text) {
    if (s_rem_count >= MAX_REMINDERS) {
        // Drop oldest entry (index 0), compact
        for (int i = 0; i < MAX_REMINDERS - 1; i++) {
            strncpy(s_rem_text[i], s_rem_text[i + 1], REMINDER_TEXT_LEN);
            s_rem_ts[i] = s_rem_ts[i + 1];
        }
        s_rem_count = MAX_REMINDERS - 1;
    }
    strncpy(s_rem_text[s_rem_count], text, REMINDER_TEXT_LEN - 1);
    s_rem_text[s_rem_count][REMINDER_TEXT_LEN - 1] = '\0';
    s_rem_ts[s_rem_count] = (uint32_t)time(NULL);
    s_rem_count++;
    reminders_save_to_persist();
}

// display_idx: 0 = newest (displayed first), maps to storage index s_rem_count-1-display_idx
static void reminders_delete(int display_idx) {
    int si = s_rem_count - 1 - display_idx;
    if (si < 0 || si >= s_rem_count) return;
    for (int i = si; i < s_rem_count - 1; i++) {
        strncpy(s_rem_text[i], s_rem_text[i + 1], REMINDER_TEXT_LEN);
        s_rem_ts[i] = s_rem_ts[i + 1];
    }
    s_rem_count--;
    reminders_save_to_persist();
}

// ============================================================================
// CONVERSATION BUFFER
// ============================================================================

static void conv_update_display(void);  // forward decl

static void conv_start(const char *question) {
    snprintf(s_conversation_buf, CONV_BUF_SIZE, "YOU: %.120s\n\n", question);
    s_conv_loading_at = (int)strlen(s_conversation_buf);
    snprintf(s_conversation_buf + s_conv_loading_at,
             CONV_BUF_SIZE - s_conv_loading_at, "AI: [thinking]");
}

static void conv_append_question(const char *question) {
    size_t used = strlen(s_conversation_buf);
    size_t avail = CONV_BUF_SIZE - used;
    if (avail < 20) return;
    snprintf(s_conversation_buf + used, avail, "\n\nYOU: %.120s\n\n", question);
    s_conv_loading_at = (int)strlen(s_conversation_buf);
    snprintf(s_conversation_buf + s_conv_loading_at,
             CONV_BUF_SIZE - s_conv_loading_at, "AI: [thinking]");
}

static void conv_set_response(const char *response) {
    if (s_conv_loading_at < 0 || s_conv_loading_at >= CONV_BUF_SIZE) return;
    snprintf(s_conversation_buf + s_conv_loading_at,
             CONV_BUF_SIZE - s_conv_loading_at, "AI: %s", response);
    s_conv_loading_at = -1;
}

static void conv_update_display(void) {
    if (!s_resp_content_layer || !s_resp_scroll_layer) return;
    text_layer_set_text(s_resp_content_layer, s_conversation_buf);
    GSize text_size = text_layer_get_content_size(s_resp_content_layer);
    GRect fr = layer_get_frame(scroll_layer_get_layer(s_resp_scroll_layer));
    int content_w = fr.size.w;
    scroll_layer_set_content_size(s_resp_scroll_layer,
        GSize(content_w, text_size.h + 8));
    // Scroll to bottom so latest content is visible
    int16_t max_scroll = text_size.h + 8 - fr.size.h;
    if (max_scroll < 0) max_scroll = 0;
    s_resp_scroll_offset = max_scroll;
    scroll_layer_set_content_offset(s_resp_scroll_layer,
        GPoint(0, -max_scroll), true);
}

// ============================================================================
// APPMESSAGE — OUTBOX
// ============================================================================

static void appmsg_send_note(const char *text, bool is_followup) {
    DictionaryIterator *iter;
    if (app_message_outbox_begin(&iter) != APP_MSG_OK) {
        set_status("Send error");
        return;
    }
    dict_write_cstring(iter, MESSAGE_KEY_NOTE_TEXT, text);
    dict_write_int8(iter, MESSAGE_KEY_NOTE_TYPE, 0);
    dict_write_int8(iter, MESSAGE_KEY_NOTE_IS_FOLLOWUP, is_followup ? 1 : 0);
    dict_write_int8(iter, MESSAGE_KEY_CLOCK_24H, clock_is_24h_style() ? 1 : 0);
    if (app_message_outbox_send() == APP_MSG_OK) {
        set_status("Routing...");
        s_waiting_response = true;
    } else {
        set_status("Send failed");
    }
}

static void appmsg_clear_context(void) {
    DictionaryIterator *iter;
    if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
    dict_write_int8(iter, MESSAGE_KEY_CLEAR_CONTEXT, 1);
    app_message_outbox_send();
}

static void appmsg_classify_note(const char *text) {
    DictionaryIterator *iter;
    if (app_message_outbox_begin(&iter) != APP_MSG_OK) return;
    dict_write_cstring(iter, MESSAGE_KEY_NOTE_TEXT, text);
    dict_write_int8(iter, MESSAGE_KEY_NOTE_IS_CLASSIFY_ONLY, 1);
    dict_write_int8(iter, MESSAGE_KEY_CLOCK_24H, clock_is_24h_style() ? 1 : 0);
    app_message_outbox_send();
}

static void route_note(bool is_followup) {
    if (s_dest_mask == 0 && !is_followup) {
        reminders_add(s_note_buf);
        set_status("Saved to reminders");
        success_window_push(DEST_LOCAL);
    } else {
        if (is_followup) {
            conv_append_question(s_note_buf);
            conv_update_display();
        } else {
            s_in_ai_thread = false;
            conv_start(s_note_buf);
        }
        appmsg_send_note(s_note_buf, is_followup);
    }
}

// ============================================================================
// APPMESSAGE — INBOX
// ============================================================================

static void inbox_received_callback(DictionaryIterator *iter, void *context) {
    // DEST_MASK — sent by phone on ready
    Tuple *mask_t = dict_find(iter, MESSAGE_KEY_DEST_MASK);
    if (mask_t) {
        s_dest_mask = (int)mask_t->value->int32;
        APP_LOG(APP_LOG_LEVEL_INFO, "dest_mask=%d", s_dest_mask);
    }

    // ROUTING_DONE — JS has decided destination
    Tuple *routing_t = dict_find(iter, MESSAGE_KEY_ROUTING_DONE);
    if (routing_t) {
        int dest = (int)routing_t->value->int32;
        if (s_confirm_open && s_confirm_target_layer) {
            // Classify-only response — update target label on confirm screen
            snprintf(s_confirm_target_buf, sizeof(s_confirm_target_buf),
                     "-> %s", dest_meta_name(dest));
            text_layer_set_text(s_confirm_target_layer, s_confirm_target_buf);
        } else {
            if (dest == DEST_AI) {
                set_status("Waiting for answer...");
            } else {
                set_status("Taking action...");
            }
        }
    }

    // CONFIRM — note was stored (non-AI destination)
    Tuple *confirm_t = dict_find(iter, MESSAGE_KEY_CONFIRM);
    if (confirm_t) {
        int ok = (int)confirm_t->value->int32;
        if (ok == 1) {
            Tuple *dest_t = dict_find(iter, MESSAGE_KEY_DEST_USED);
            int dest = dest_t ? (int)dest_t->value->int32 : 0;
            if (dest == DEST_LOCAL) {
                reminders_add(s_note_buf);
                set_status("Saved locally ✓");
            } else {
                history_save_item(s_note_buf, NULL, dest);
                char msg[STATUS_BUF_SIZE];
                snprintf(msg, sizeof(msg), "Sent → %s ✓", dest_short_name(dest));
                set_status(msg);
            }
            success_window_push(dest);
        } else {
            Tuple *err_t = dict_find(iter, MESSAGE_KEY_ERROR_MSG);
            if (err_t && err_t->value->cstring[0]) {
                set_status(err_t->value->cstring);
            } else {
                set_status("Error — check phone");
            }
        }
        s_waiting_response = false;
    }

    // AI_RESPONSE — show on response window
    Tuple *ai_t = dict_find(iter, MESSAGE_KEY_AI_RESPONSE);
    if (ai_t) {
        strncpy(s_ai_response_buf, ai_t->value->cstring, NOTE_BUF_SIZE - 1);
        s_ai_response_buf[NOTE_BUF_SIZE - 1] = '\0';
    }

    Tuple *done_t = dict_find(iter, MESSAGE_KEY_AI_RESPONSE_DONE);
    if (done_t && done_t->value->int32 == 1) {
        s_waiting_response = false;
        set_status("AI responded");
        conv_set_response(s_ai_response_buf);
        if (s_in_ai_thread) {
            history_update_latest(s_conversation_buf);
        } else {
            Tuple *dest_t = dict_find(iter, MESSAGE_KEY_DEST_USED);
            int dest = dest_t ? (int)dest_t->value->int32 : DEST_AI;
            history_save_item(s_note_buf, s_conversation_buf, dest);
            s_in_ai_thread = true;
        }
        if (s_response_open) {
            conv_update_display();
        } else {
            response_window_push();
        }
    }
}

static void inbox_dropped_callback(AppMessageResult reason, void *context) {
    APP_LOG(APP_LOG_LEVEL_WARNING, "Inbox dropped: %d", (int)reason);
}

static void outbox_failed_callback(DictionaryIterator *iter,
                                   AppMessageResult reason, void *context) {
    set_status("Send failed");
    s_waiting_response = false;
}

// ============================================================================
// DICTATION CALLBACK
// ============================================================================

static void dictation_callback(DictationSession *session,
                                DictationSessionStatus status,
                                char *transcription, void *context) {
    bool is_followup = s_is_followup;
    s_is_followup = false;   // consume flag

    if (status == DictationSessionStatusSuccess) {
        strncpy(s_note_buf, transcription, NOTE_BUF_SIZE - 1);
        s_note_buf[NOTE_BUF_SIZE - 1] = '\0';
        APP_LOG(APP_LOG_LEVEL_INFO, "Dictation: %s", s_note_buf);
        s_confirm_is_followup = is_followup;
        confirm_window_push();
    } else {
        switch (status) {
            case DictationSessionStatusFailureNoSpeechDetected:
                set_status("No speech detected"); break;
            case DictationSessionStatusFailureConnectivityError:
                set_status("No connection"); break;
            case DictationSessionStatusFailureRecognizerError:
                set_status("Transcription error"); break;
            case DictationSessionStatusFailureDisabled:
                set_status("Dictation disabled"); break;
            default:
                set_status("Dictation failed"); break;
        }
    }
}

// ============================================================================
// DRAW — CHROME & ICONS
// ============================================================================

// Brain outline — 87 points at scale=100.
#define BRAIN_N 87
static const int8_t BRAIN_PX[BRAIN_N] = {
    -4, -5, -6, -7, -8, -8, -9,-10,-11,-12,-13,-14,-14,-14,-14,-15,-15,-15,-15,-15,
   -14,-14,-13,-12,-12,-12,-12,-11,-10, -9, -8, -7, -6, -6, -5, -4, -3, -2, -1,  0,
     1,  1,  2,  3,  4,  5,  6,  7,  8,  9, 10, 11, 12, 12, 12, 12, 12, 13, 14, 14,
    15, 15, 15, 15, 15, 14, 14, 14, 14, 13, 12, 11, 10,  9,  8,  8,  7,  6,  5,  4,
     3,  2,  1,  0, -1, -2, -3
};
static const int8_t BRAIN_PY[BRAIN_N] = {
   -15,-15,-14,-14,-13,-12,-11,-11,-10, -9, -8, -6, -5, -4, -3, -2, -1,  0,  1,  2,
     3,  4,  5,  6,  6,  8,  9, 10, 11, 12, 12, 12, 13, 14, 15, 15, 15, 15, 14, 14,
    14, 15, 15, 15, 15, 14, 14, 13, 12, 12, 11, 11,  9,  8,  7,  6,  6,  5,  4,  3,
     2,  1,  0, -1, -2, -3, -4, -5, -6, -8, -9,-10,-11,-11,-12,-13,-14,-14,-15,-15,
   -15,-15,-14,-13,-14,-15,-15
};

static void draw_action_bar(GContext *ctx, GRect bounds) {
#ifdef PBL_ROUND
    {
        // Thin right-edge crescent: full white disc minus a slightly larger black
        // disc shifted left, leaving a ~30px white sliver hugging the right edge.
        int R = bounds.size.w / 2;
        graphics_context_set_fill_color(ctx, C_BAR);
        graphics_fill_circle(ctx, GPoint(R, R), (uint16_t)R);
        graphics_context_set_fill_color(ctx, C_SCREEN);
        graphics_fill_circle(ctx, GPoint(R * 15 / 100, R), (uint16_t)(R * 152 / 100));
    }
#else
    graphics_context_set_fill_color(ctx, C_BAR);
    graphics_fill_rect(ctx, GRect(action_bar_x(bounds), 0, ACTION_BAR_W, bounds.size.h),
                       0, GCornerNone);
#endif
}

static int action_bar_icon_x(GRect bounds) {
    return action_bar_x(bounds) + ACTION_BAR_W / 2;
}

// 1px hairline beneath the status bar (handoff: ~10% white). DarkGray is the
// closest representable tone on the 64-color display; invisible on 1-bit.
static void draw_status_divider(GContext *ctx, GRect bounds) {
    graphics_context_set_stroke_color(ctx, GColorDarkGray);
    graphics_context_set_stroke_width(ctx, 1);
    int w = content_area_w(bounds);
    graphics_draw_line(ctx, GPoint(4, STATUS_H), GPoint(w - 4, STATUS_H));
}

// Record / dump chip — filled rounded square enclosing a record dot.
static void draw_icon_record(GContext *ctx, GPoint c, GColor color) {
    GColor hole = gcolor_equal(color, C_ON_BAR) ? C_BAR : C_ON_BAR;
    graphics_context_set_fill_color(ctx, color);
    graphics_fill_rect(ctx, GRect(c.x - 9, c.y - 9, 18, 18), 4, GCornersAll);
    graphics_context_set_fill_color(ctx, hole);
    graphics_fill_circle(ctx, c, 4);
}

static void draw_icon_hamburger(GContext *ctx, GPoint c, GColor color) {
    graphics_context_set_stroke_color(ctx, color);
    graphics_context_set_stroke_width(ctx, 2);
    for (int i = -1; i <= 1; i++) {
        graphics_draw_line(ctx, GPoint(c.x - 7, c.y + i * 4),
                                GPoint(c.x + 7, c.y + i * 4));
    }
}

static void draw_icon_redo(GContext *ctx, GPoint c, GColor color) {
    graphics_context_set_stroke_color(ctx, color);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_circle(ctx, c, 8);
    graphics_draw_line(ctx, GPoint(c.x + 5, c.y - 7), GPoint(c.x + 9, c.y - 3));
    graphics_draw_line(ctx, GPoint(c.x + 5, c.y - 7), GPoint(c.x + 3, c.y - 3));
}

static void draw_icon_send(GContext *ctx, GPoint c, GColor color) {
    graphics_context_set_stroke_color(ctx, color);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(c.x, c.y + 7), GPoint(c.x, c.y - 5));
    graphics_draw_line(ctx, GPoint(c.x - 6, c.y - 1), GPoint(c.x, c.y - 7));
    graphics_draw_line(ctx, GPoint(c.x + 6, c.y - 1), GPoint(c.x, c.y - 7));
}

static void draw_icon_reply(GContext *ctx, GPoint c, GColor color) {
    draw_icon_send(ctx, c, color);
}

static void draw_brain_icon(GContext *ctx, GPoint center, int scale, GColor color) {
    int cx = center.x;
    int cy = center.y;

    graphics_context_set_stroke_color(ctx, color);
    graphics_context_set_stroke_width(ctx, 2);

    for (int i = 0; i < BRAIN_N; i++) {
        graphics_draw_line(ctx,
            GPoint(cx + BRAIN_PX[i]             * scale / 100, cy + BRAIN_PY[i]             * scale / 100),
            GPoint(cx + BRAIN_PX[(i + 1) % BRAIN_N] * scale / 100, cy + BRAIN_PY[(i + 1) % BRAIN_N] * scale / 100));
    }

    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_line(ctx,
        GPoint(cx, cy - 13 * scale / 100),
        GPoint(cx, cy + 14 * scale / 100));
}

static void draw_mic_stem(GContext *ctx, GPoint center, int scale, GColor color) {
    int bw = 14 * scale / 100;
    int bh = 22 * scale / 100;
    int br =  7 * scale / 100;
    if (br < 2) br = 2;

    GRect body = GRect(center.x - bw / 2, center.y - bh / 2, bw, bh);
    graphics_context_set_fill_color(ctx, color);
    graphics_fill_rect(ctx, body, (uint16_t)br, GCornersAll);

    graphics_context_set_stroke_color(ctx, color);
    graphics_context_set_stroke_width(ctx, 2);
    int stem_top = center.y + bh / 2;
    int stem_bottom = stem_top + 5 * scale / 100;
    graphics_draw_line(ctx, GPoint(center.x, stem_top), GPoint(center.x, stem_bottom));
    int base_half = 4 * scale / 100;
    if (base_half < 2) base_half = 2;
    graphics_draw_line(ctx, GPoint(center.x - base_half, stem_bottom),
                            GPoint(center.x + base_half, stem_bottom));
}

static void draw_brain_mic_glyph(GContext *ctx, GPoint center, int scale, GColor color) {
    draw_brain_icon(ctx, GPoint(center.x, center.y - 8), scale, color);
    draw_mic_stem(ctx, GPoint(center.x, center.y + 18), scale * 85 / 100, color);
}

// --- Per-destination vector glyphs (drawn in fg color, centered at c) ---

// Sparkle / 4-point star — AI route
static void draw_glyph_sparkle(GContext *ctx, GPoint c, GColor fg) {
    graphics_context_set_stroke_color(ctx, fg);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(c.x, c.y - 5), GPoint(c.x, c.y + 5));
    graphics_draw_line(ctx, GPoint(c.x - 5, c.y), GPoint(c.x + 5, c.y));
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_line(ctx, GPoint(c.x - 3, c.y - 3), GPoint(c.x + 3, c.y + 3));
    graphics_draw_line(ctx, GPoint(c.x - 3, c.y + 3), GPoint(c.x + 3, c.y - 3));
}

// Check mark — Tasks
static void draw_glyph_check(GContext *ctx, GPoint c, GColor fg) {
    graphics_context_set_stroke_color(ctx, fg);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_line(ctx, GPoint(c.x - 5, c.y + 1), GPoint(c.x - 1, c.y + 5));
    graphics_draw_line(ctx, GPoint(c.x - 1, c.y + 5), GPoint(c.x + 6, c.y - 4));
}

// Three stacked lines — local Note
static void draw_glyph_lines(GContext *ctx, GPoint c, GColor fg) {
    graphics_context_set_stroke_color(ctx, fg);
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_line(ctx, GPoint(c.x - 5, c.y - 4), GPoint(c.x + 5, c.y - 4));
    graphics_draw_line(ctx, GPoint(c.x - 5, c.y),     GPoint(c.x + 5, c.y));
    graphics_draw_line(ctx, GPoint(c.x - 5, c.y + 4), GPoint(c.x + 1, c.y + 4));
}

// Draw a single letter monogram centered at c, in fg color.
static void draw_glyph_letter(GContext *ctx, char letter, GPoint c, GColor fg) {
    char ch[2] = { letter, '\0' };
    GFont font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
    graphics_context_set_text_color(ctx, fg);
    graphics_draw_text(ctx, ch, font,
        GRect(c.x - 9, c.y - 10, 18, 18),
        GTextOverflowModeFill, GTextAlignmentCenter, NULL);
}

// Dispatch: draw the destination's glyph centered at c.
static void draw_dest_glyph(GContext *ctx, int dest, GPoint c, GColor fg) {
    switch (dest) {
        case DEST_AI:        draw_glyph_sparkle(ctx, c, fg); break;
        case DEST_TASKS:     draw_glyph_check(ctx, c, fg);   break;
        case DEST_LOCAL:     draw_glyph_lines(ctx, c, fg);   break;
        case DEST_NOTION:    draw_glyph_letter(ctx, 'N', c, fg); break;
        case DEST_TODOIST:   draw_glyph_letter(ctx, 'T', c, fg); break;
        case DEST_WEBHOOK:   draw_glyph_letter(ctx, 'H', c, fg); break;
        case DEST_NEXTCLOUD: draw_glyph_letter(ctx, 'C', c, fg); break;
        default:             draw_glyph_letter(ctx, '?', c, fg); break;
    }
}

// Bordered rounded-square tile (transparent interior) with the dest glyph,
// both stroked in fg. Matches the handoff's leading-icon / chip style.
static void draw_dest_tile(GContext *ctx, int dest, GPoint center, int size, GColor fg) {
    GRect box = GRect(center.x - size / 2, center.y - size / 2, size, size);
    graphics_context_set_stroke_color(ctx, fg);
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_round_rect(ctx, box, 3);
    draw_dest_glyph(ctx, dest, center, fg);
}

// ============================================================================
// CONFIRM WINDOW  (review transcription + target before routing)
// ============================================================================

#define CONFIRM_HINT_W ACTION_BAR_W

static void confirm_canvas_update(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    graphics_context_set_fill_color(ctx, C_SCREEN);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    draw_action_bar(ctx, bounds);
    int ax = action_bar_icon_x(bounds);
    draw_icon_redo(ctx, GPoint(ax, btn_y_at(bounds, 18)), C_ON_BAR);
    draw_icon_send(ctx, GPoint(ax, btn_y_at(bounds, 47)), C_ON_BAR);
}

static void confirm_route_cb(void *ctx) {
    route_note(s_confirm_is_followup);
}

static void confirm_redo_cb(void *ctx) {
    s_is_followup = s_confirm_is_followup;
    dictation_session_start(s_dictation_session);
}

static void confirm_select_click(ClickRecognizerRef rec, void *ctx) {
    window_stack_pop(true);
    app_timer_register(50, confirm_route_cb, NULL);
}

static void confirm_up_click(ClickRecognizerRef rec, void *ctx) {
    window_stack_pop(true);
    app_timer_register(300, confirm_redo_cb, NULL);
}

static void confirm_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_SELECT, confirm_select_click);
    window_single_click_subscribe(BUTTON_ID_UP,     confirm_up_click);
}

static void confirm_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);

    window_set_background_color(window, C_SCREEN);

    int content_w = content_area_w(b) - 8;

    s_confirm_canvas_layer = layer_create(b);
    layer_set_update_proc(s_confirm_canvas_layer, confirm_canvas_update);
    layer_add_child(root, s_confirm_canvas_layer);

    s_confirm_title_layer = text_layer_create(GRect(4, 1, content_w, STATUS_H));
    text_layer_set_background_color(s_confirm_title_layer, GColorClear);
    text_layer_set_text_color(s_confirm_title_layer, C_ON_SCREEN);
    text_layer_set_font(s_confirm_title_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text(s_confirm_title_layer, "REVIEW");
    layer_add_child(root, text_layer_get_layer(s_confirm_title_layer));

    s_confirm_content_layer = text_layer_create(
        GRect(4, STATUS_H + 4, content_w, b.size.h - STATUS_H - 34));
    text_layer_set_background_color(s_confirm_content_layer, GColorClear);
    text_layer_set_text_color(s_confirm_content_layer, C_ON_SCREEN);
    text_layer_set_font(s_confirm_content_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_18));
    text_layer_set_overflow_mode(s_confirm_content_layer, GTextOverflowModeWordWrap);
    text_layer_set_text(s_confirm_content_layer, s_note_buf);
    layer_add_child(root, text_layer_get_layer(s_confirm_content_layer));

    snprintf(s_confirm_target_buf, sizeof(s_confirm_target_buf), "-> ?");
    s_confirm_target_layer = text_layer_create(
        GRect(4, b.size.h - 22, content_w, 18));
    text_layer_set_background_color(s_confirm_target_layer, GColorClear);
    text_layer_set_text_color(s_confirm_target_layer, C_ON_SCREEN);
    text_layer_set_font(s_confirm_target_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text(s_confirm_target_layer, s_confirm_target_buf);
    layer_add_child(root, text_layer_get_layer(s_confirm_target_layer));

    window_set_click_config_provider(window, confirm_click_config);
    s_confirm_open = true;
}

static void confirm_window_unload(Window *window) {
    layer_destroy(s_confirm_canvas_layer);     s_confirm_canvas_layer  = NULL;
    text_layer_destroy(s_confirm_title_layer); s_confirm_title_layer = NULL;
    text_layer_destroy(s_confirm_content_layer); s_confirm_content_layer = NULL;
    text_layer_destroy(s_confirm_target_layer);  s_confirm_target_layer  = NULL;
    s_confirm_open = false;
}

// ============================================================================
// SUCCESS ("DUMPED") WINDOW — post-dump confirmation, auto-dismiss ~1.5s
// ============================================================================

#define SUCCESS_DISMISS_MS 1500

// Larger check mark for the medallion (scaled by radius r around center c).
static void draw_check_big(GContext *ctx, GPoint c, int r, GColor fg) {
    graphics_context_set_stroke_color(ctx, fg);
    graphics_context_set_stroke_width(ctx, 3);
    int x0 = c.x - r * 45 / 100, y0 = c.y + r * 5 / 100;
    int x1 = c.x - r * 8 / 100,  y1 = c.y + r * 42 / 100;
    int x2 = c.x + r * 48 / 100, y2 = c.y - r * 40 / 100;
    graphics_draw_line(ctx, GPoint(x0, y0), GPoint(x1, y1));
    graphics_draw_line(ctx, GPoint(x1, y1), GPoint(x2, y2));
}

static void success_canvas_update(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    int w = bounds.size.w;
    int h = bounds.size.h;

    graphics_context_set_fill_color(ctx, C_SCREEN);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    // Status bar: "SAVED" (dimmed) + clock (white)
    graphics_context_set_text_color(ctx, GColorLightGray);
    graphics_draw_text(ctx, "SAVED", fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(4, 1, w - 56, STATUS_H), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
    graphics_context_set_text_color(ctx, C_ON_SCREEN);
    graphics_draw_text(ctx, s_clock_buf, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(w - 52, 1, 48, STATUS_H), GTextOverflowModeFill, GTextAlignmentRight, NULL);

    // Medallion: ring + check
    int med_cy = h * 27 / 100;
    int med_r  = 22;
    graphics_context_set_stroke_color(ctx, C_ON_SCREEN);
    graphics_context_set_stroke_width(ctx, 2);
    graphics_draw_circle(ctx, GPoint(w / 2, med_cy), med_r);
    draw_check_big(ctx, GPoint(w / 2, med_cy), med_r, C_ON_SCREEN);

    // Title "DUMPED"
    graphics_context_set_text_color(ctx, C_ON_SCREEN);
    graphics_draw_text(ctx, "DUMPED", fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD),
        GRect(0, h * 43 / 100, w, 30), GTextOverflowModeFill, GTextAlignmentCenter, NULL);

    // Destination chip: bordered tile + name caps, centered as a group
    const char *name = dest_meta_name(s_success_dest);
    GFont chip_font = fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD);
    GSize ns = graphics_text_layout_get_content_size(name, chip_font,
        GRect(0, 0, w, 20), GTextOverflowModeFill, GTextAlignmentLeft);
    int tile = 20, gap = 6;
    int group_w = tile + gap + ns.w;
    int gx = (w - group_w) / 2;
    int chip_cy = h * 62 / 100;
    draw_dest_tile(ctx, s_success_dest, GPoint(gx + tile / 2, chip_cy), tile, C_ON_SCREEN);
    graphics_context_set_text_color(ctx, C_ON_SCREEN);
    graphics_draw_text(ctx, name, chip_font,
        GRect(gx + tile + gap, chip_cy - 10, ns.w + 4, 20),
        GTextOverflowModeFill, GTextAlignmentLeft, NULL);

    // Transcript quote (dimmed, up to 2 lines)
    graphics_context_set_text_color(ctx, GColorLightGray);
    graphics_draw_text(ctx, s_success_quote, fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(8, h * 72 / 100, w - 16, 40),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentCenter, NULL);
}

static void success_dismiss_cb(void *ctx) {
    s_success_timer = NULL;
    if (s_success_window && window_stack_get_top_window() == s_success_window) {
        window_stack_pop(true);
    }
}

static void success_dismiss_click(ClickRecognizerRef rec, void *ctx) {
    if (s_success_timer) { app_timer_cancel(s_success_timer); s_success_timer = NULL; }
    window_stack_pop(true);
}

static void success_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_SELECT, success_dismiss_click);
    window_single_click_subscribe(BUTTON_ID_BACK,   success_dismiss_click);
}

static void success_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);
    window_set_background_color(window, C_SCREEN);

    s_success_canvas_layer = layer_create(b);
    layer_set_update_proc(s_success_canvas_layer, success_canvas_update);
    layer_add_child(root, s_success_canvas_layer);

    window_set_click_config_provider(window, success_click_config);
    s_success_timer = app_timer_register(SUCCESS_DISMISS_MS, success_dismiss_cb, NULL);
}

static void success_window_unload(Window *window) {
    if (s_success_timer) { app_timer_cancel(s_success_timer); s_success_timer = NULL; }
    layer_destroy(s_success_canvas_layer); s_success_canvas_layer = NULL;
}

// ============================================================================
// HOME WINDOW
// ============================================================================

static void canvas_update_proc(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);

    graphics_context_set_fill_color(ctx, C_SCREEN);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    draw_action_bar(ctx, bounds);
    draw_status_divider(ctx, bounds);

#ifdef PBL_ROUND
    int cx = bounds.size.w / 2;   // true center; thin crescent leaves room
#else
    int cx = content_area_w(bounds) / 2;
#endif
    int cy = bounds.size.h * 44 / 100;
    draw_brain_mic_glyph(ctx, GPoint(cx, cy), 130, C_ON_SCREEN);

    int ax = action_bar_icon_x(bounds);
    draw_icon_hamburger(ctx, GPoint(ax, btn_y_at(bounds, 18)), C_ON_BAR);
    draw_icon_record(ctx, GPoint(ax, btn_y_at(bounds, 47)), C_ON_BAR);

    if (s_waiting_response) {
        graphics_context_set_fill_color(ctx, C_ON_SCREEN);
        graphics_fill_circle(ctx, GPoint(content_area_w(bounds) - 6, 6), 3);
    }
}

static void home_select_click(ClickRecognizerRef rec, void *ctx) {
    if (!connection_service_peek_pebble_app_connection()) {
        set_status("Connect phone first");
        return;
    }
    dictation_session_start(s_dictation_session);
}

static void home_up_click(ClickRecognizerRef rec, void *ctx) {
    history_window_push();
}

#ifdef DEBUG_SEED
static void home_debug_success_click(ClickRecognizerRef rec, void *ctx) {
    strncpy(s_note_buf, "Draft the Q3 deck outline for Sarah", NOTE_BUF_SIZE - 1);
    success_window_push(DEST_NOTION);
}
#endif

static void home_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_SELECT, home_select_click);
    window_single_click_subscribe(BUTTON_ID_UP,     home_up_click);
#ifdef DEBUG_SEED
    window_single_click_subscribe(BUTTON_ID_DOWN,   home_debug_success_click);
#endif
}

static void home_clock_tick(struct tm *tick_time, TimeUnits changed) {
    if (!s_home_clock_layer) return;
    if (clock_is_24h_style()) {
        snprintf(s_clock_buf, sizeof(s_clock_buf), "%02d:%02d",
                 tick_time->tm_hour, tick_time->tm_min);
    } else {
        int h = tick_time->tm_hour % 12;
        if (h == 0) h = 12;
        snprintf(s_clock_buf, sizeof(s_clock_buf), "%d:%02d", h, tick_time->tm_min);
    }
    text_layer_set_text(s_home_clock_layer, s_clock_buf);
}

static void home_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);
    int content_w = content_area_w(b);

    window_set_background_color(window, C_SCREEN);

    s_canvas_layer = layer_create(b);
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(root, s_canvas_layer);

    s_home_title_layer = text_layer_create(GRect(4, 1, content_w - 52, STATUS_H));
    text_layer_set_background_color(s_home_title_layer, GColorClear);
    text_layer_set_text_color(s_home_title_layer, GColorLightGray);
    text_layer_set_font(s_home_title_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text(s_home_title_layer, "DUMP");
    layer_add_child(root, text_layer_get_layer(s_home_title_layer));

    s_home_clock_layer = text_layer_create(GRect(content_w - 52, 1, 48, STATUS_H));
    text_layer_set_background_color(s_home_clock_layer, GColorClear);
    text_layer_set_text_color(s_home_clock_layer, C_ON_SCREEN);
    text_layer_set_font(s_home_clock_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text_alignment(s_home_clock_layer, GTextAlignmentRight);
    text_layer_set_text(s_home_clock_layer, "");
    layer_add_child(root, text_layer_get_layer(s_home_clock_layer));
    tick_timer_service_subscribe(MINUTE_UNIT, home_clock_tick);
    time_t now = time(NULL);
    struct tm *tick_time = localtime(&now);
    home_clock_tick(tick_time, MINUTE_UNIT);

    int hero_y = b.size.h * 58 / 100;
#ifdef PBL_ROUND
    int text_w = b.size.w;   // center across full width on round
#else
    int text_w = content_w;
#endif
    s_hero_layer = text_layer_create(GRect(0, hero_y, text_w, 30));
    text_layer_set_background_color(s_hero_layer, GColorClear);
    text_layer_set_text_color(s_hero_layer, C_ON_SCREEN);
    text_layer_set_font(s_hero_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_24_BOLD));
    text_layer_set_text_alignment(s_hero_layer, GTextAlignmentCenter);
    text_layer_set_text(s_hero_layer, "READY");
    layer_add_child(root, text_layer_get_layer(s_hero_layer));

    s_meta_layer = text_layer_create(GRect(0, hero_y + 28, text_w, 20));
    text_layer_set_background_color(s_meta_layer, GColorClear);
    text_layer_set_text_color(s_meta_layer, GColorLightGray);
    text_layer_set_font(s_meta_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_meta_layer, GTextAlignmentCenter);
    text_layer_set_text(s_meta_layer, "PRESS TO SPEAK");
    layer_add_child(root, text_layer_get_layer(s_meta_layer));

    window_set_click_config_provider(window, home_click_config);

    strncpy(s_status_buf, "Ready", STATUS_BUF_SIZE - 1);
}

static void home_window_unload(Window *window) {
    layer_destroy(s_canvas_layer);              s_canvas_layer       = NULL;
    text_layer_destroy(s_home_title_layer);     s_home_title_layer   = NULL;
    text_layer_destroy(s_home_clock_layer);     s_home_clock_layer   = NULL;
    text_layer_destroy(s_hero_layer);           s_hero_layer         = NULL;
    text_layer_destroy(s_meta_layer);           s_meta_layer         = NULL;
}

// ============================================================================
// RESPONSE WINDOW  (AI replies)
// ============================================================================

#define RESP_SCROLL_STEP 36

static void resp_up_click(ClickRecognizerRef rec, void *ctx) {
    s_resp_scroll_offset -= RESP_SCROLL_STEP;
    if (s_resp_scroll_offset < 0) s_resp_scroll_offset = 0;
    scroll_layer_set_content_offset(s_resp_scroll_layer,
        GPoint(0, -s_resp_scroll_offset), true);
}

static void resp_down_click(ClickRecognizerRef rec, void *ctx) {
    GSize cs = scroll_layer_get_content_size(s_resp_scroll_layer);
    GRect fr = layer_get_frame(scroll_layer_get_layer(s_resp_scroll_layer));
    int16_t max_scroll = cs.h - fr.size.h;
    if (max_scroll < 0) max_scroll = 0;
    s_resp_scroll_offset += RESP_SCROLL_STEP;
    if (s_resp_scroll_offset > max_scroll) s_resp_scroll_offset = max_scroll;
    scroll_layer_set_content_offset(s_resp_scroll_layer,
        GPoint(0, -s_resp_scroll_offset), true);
}

static void resp_select_click(ClickRecognizerRef rec, void *ctx) {
    if (!connection_service_peek_pebble_app_connection()) {
        set_status("Connect phone first");
        return;
    }
    s_is_followup = true;
    dictation_session_start(s_dictation_session);
}

static void resp_back_click(ClickRecognizerRef rec, void *ctx) {
    s_is_followup  = false;
    s_in_ai_thread = false;
    appmsg_clear_context();
    s_response_open = false;
    window_stack_pop(true);
}

static void resp_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_UP,     resp_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN,   resp_down_click);
    window_single_click_subscribe(BUTTON_ID_SELECT, resp_select_click);
    window_single_click_subscribe(BUTTON_ID_BACK,   resp_back_click);
}

static Layer *s_resp_canvas_layer;

static void resp_canvas_update(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    graphics_context_set_fill_color(ctx, C_SCREEN);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);
    draw_action_bar(ctx, bounds);
    draw_icon_reply(ctx, GPoint(action_bar_icon_x(bounds), btn_y_at(bounds, 47)), C_ON_BAR);
}

static void response_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);
    int content_w = content_area_w(b);

    window_set_background_color(window, C_SCREEN);

    s_resp_canvas_layer = layer_create(b);
    layer_set_update_proc(s_resp_canvas_layer, resp_canvas_update);
    layer_add_child(root, s_resp_canvas_layer);

    s_resp_header_layer = text_layer_create(GRect(4, 1, content_w - 8, STATUS_H));
    text_layer_set_background_color(s_resp_header_layer, GColorClear);
    text_layer_set_text_color(s_resp_header_layer, C_ON_SCREEN);
    text_layer_set_font(s_resp_header_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_overflow_mode(s_resp_header_layer, GTextOverflowModeTrailingEllipsis);
    text_layer_set_text(s_resp_header_layer, "AI");
    layer_add_child(root, text_layer_get_layer(s_resp_header_layer));

    int scroll_top  = STATUS_H + 4;
    int scroll_h    = b.size.h - scroll_top;
    GRect scroll_frame = GRect(0, scroll_top, content_w, scroll_h);

    s_resp_scroll_offset = 0;
    s_resp_scroll_layer = scroll_layer_create(scroll_frame);
    layer_add_child(root, scroll_layer_get_layer(s_resp_scroll_layer));

    int content_w_inner = content_w - 8;
    s_resp_content_layer = text_layer_create(GRect(4, 4, content_w_inner, 2000));
    text_layer_set_background_color(s_resp_content_layer, GColorClear);
    text_layer_set_text_color(s_resp_content_layer, C_ON_SCREEN);
    text_layer_set_font(s_resp_content_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_24));
    text_layer_set_overflow_mode(s_resp_content_layer, GTextOverflowModeWordWrap);
    text_layer_set_text(s_resp_content_layer, s_conversation_buf);
    scroll_layer_add_child(s_resp_scroll_layer,
                           text_layer_get_layer(s_resp_content_layer));

    // Set content size to fit text
    GSize text_size = text_layer_get_content_size(s_resp_content_layer);
    scroll_layer_set_content_size(s_resp_scroll_layer,
        GSize(content_w_inner, text_size.h + 8));

    window_set_click_config_provider(window, resp_click_config);
    s_response_open = true;
}

static void response_window_unload(Window *window) {
    layer_destroy(s_resp_canvas_layer);       s_resp_canvas_layer  = NULL;
    text_layer_destroy(s_resp_header_layer);  s_resp_header_layer  = NULL;
    text_layer_destroy(s_resp_content_layer); s_resp_content_layer = NULL;
    scroll_layer_destroy(s_resp_scroll_layer); s_resp_scroll_layer = NULL;
    s_response_open = false;
}

// ============================================================================
// DETAIL WINDOW  (full history transcript)
// ============================================================================

static void detail_up_click(ClickRecognizerRef rec, void *ctx) {
    s_detail_scroll_offset -= RESP_SCROLL_STEP;
    if (s_detail_scroll_offset < 0) s_detail_scroll_offset = 0;
    scroll_layer_set_content_offset(s_detail_scroll_layer,
        GPoint(0, -s_detail_scroll_offset), true);
}

static void detail_down_click(ClickRecognizerRef rec, void *ctx) {
    GSize cs = scroll_layer_get_content_size(s_detail_scroll_layer);
    GRect fr = layer_get_frame(scroll_layer_get_layer(s_detail_scroll_layer));
    int16_t max_scroll = cs.h - fr.size.h;
    if (max_scroll < 0) max_scroll = 0;
    s_detail_scroll_offset += RESP_SCROLL_STEP;
    if (s_detail_scroll_offset > max_scroll) s_detail_scroll_offset = max_scroll;
    scroll_layer_set_content_offset(s_detail_scroll_layer,
        GPoint(0, -s_detail_scroll_offset), true);
}

static void detail_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_UP,   detail_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN, detail_down_click);
}

static void detail_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);
    int content_w = content_area_w(b);

    window_set_background_color(window, C_SCREEN);

    static char s_detail_header_buf[HISTORY_SHORT_LEN];
    strncpy(s_detail_header_buf, s_history_short[s_detail_idx], sizeof(s_detail_header_buf) - 1);
    s_detail_header_buf[sizeof(s_detail_header_buf) - 1] = '\0';

    s_detail_header_layer = text_layer_create(GRect(4, 1, content_w - 8, STATUS_H));
    text_layer_set_background_color(s_detail_header_layer, GColorClear);
    text_layer_set_text_color(s_detail_header_layer, C_ON_SCREEN);
    text_layer_set_font(s_detail_header_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_overflow_mode(s_detail_header_layer, GTextOverflowModeTrailingEllipsis);
    text_layer_set_text(s_detail_header_layer, s_detail_header_buf);
    layer_add_child(root, text_layer_get_layer(s_detail_header_layer));

    s_detail_scroll_offset = 0;
    GRect scroll_frame = GRect(0, STATUS_H + 2, content_w, b.size.h - STATUS_H - 2);
    s_detail_scroll_layer = scroll_layer_create(scroll_frame);
    layer_add_child(root, scroll_layer_get_layer(s_detail_scroll_layer));

    int inner_w = content_w - 8;
    s_detail_content_layer = text_layer_create(GRect(4, 4, inner_w, 2000));
    text_layer_set_background_color(s_detail_content_layer, GColorClear);
    text_layer_set_text_color(s_detail_content_layer, C_ON_SCREEN);
    text_layer_set_font(s_detail_content_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_24));
    text_layer_set_overflow_mode(s_detail_content_layer, GTextOverflowModeWordWrap);
    text_layer_set_text(s_detail_content_layer, s_history_full[s_detail_idx]);
    scroll_layer_add_child(s_detail_scroll_layer,
                           text_layer_get_layer(s_detail_content_layer));

    GSize ts = text_layer_get_content_size(s_detail_content_layer);
    scroll_layer_set_content_size(s_detail_scroll_layer,
        GSize(inner_w, ts.h + 8));

    window_set_click_config_provider(window, detail_click_config);
}

static void detail_window_unload(Window *window) {
    text_layer_destroy(s_detail_header_layer);   s_detail_header_layer  = NULL;
    text_layer_destroy(s_detail_content_layer);  s_detail_content_layer = NULL;
    scroll_layer_destroy(s_detail_scroll_layer); s_detail_scroll_layer  = NULL;
}

// ============================================================================
// MERGED HISTORY
// ============================================================================

static void merged_rebuild(void) {
    s_merged_count = 0;

    for (int i = 0; i < s_history_count && s_merged_count < MAX_MERGED; i++) {
        MergedEntry *e = &s_merged[s_merged_count++];
        e->kind = MERGED_SMART;
        e->src_idx = i;
        e->dest = s_history_dest[i];
        e->timestamp = s_history_ts[i];
        strncpy(e->title, s_history_short[i], HISTORY_SHORT_LEN - 1);
        e->title[HISTORY_SHORT_LEN - 1] = '\0';
        format_relative_meta(e->timestamp, e->dest, e->meta, sizeof(e->meta));
    }

    for (int i = 0; i < s_rem_count && s_merged_count < MAX_MERGED; i++) {
        int si = s_rem_count - 1 - i;
        MergedEntry *e = &s_merged[s_merged_count++];
        e->kind = MERGED_LOCAL;
        e->src_idx = i;
        e->dest = DEST_LOCAL;
        e->timestamp = s_rem_ts[si];
        strncpy(e->title, s_rem_text[si], HISTORY_SHORT_LEN - 1);
        e->title[HISTORY_SHORT_LEN - 1] = '\0';
        format_relative_meta(e->timestamp, DEST_LOCAL, e->meta, sizeof(e->meta));
    }

    for (int i = 0; i < s_merged_count - 1; i++) {
        for (int j = i + 1; j < s_merged_count; j++) {
            if (s_merged[j].timestamp > s_merged[i].timestamp) {
                MergedEntry tmp = s_merged[i];
                s_merged[i] = s_merged[j];
                s_merged[j] = tmp;
            }
        }
    }
}

static void merged_item_open(int index) {
    if (index < 0 || index >= s_merged_count) return;
    if (s_merged[index].kind == MERGED_SMART) {
        detail_window_push(s_merged[index].src_idx);
    } else {
        rem_detail_window_push(s_merged[index].src_idx);
    }
}

// Draw one merged row at top-left (0,y) within width w.
static void draw_merged_row(GContext *ctx, const MergedEntry *e, int y, int w, bool selected) {
    graphics_context_set_fill_color(ctx, selected ? C_BAR : C_SCREEN);
    graphics_fill_rect(ctx, GRect(0, y, w, MENU_ROW_H), 0, GCornerNone);

    GColor fg      = selected ? C_ON_BAR : C_ON_SCREEN;
    GColor meta_fg = selected ? C_ON_BAR : GColorLightGray;

    int tile_cx = 6 + MENU_TILE_SIZE / 2;
    draw_dest_tile(ctx, e->dest, GPoint(tile_cx, y + MENU_ROW_H / 2), MENU_TILE_SIZE, fg);

    int text_x = tile_cx + MENU_TILE_SIZE / 2 + 8;
    int text_w = w - text_x - 4;
    graphics_context_set_text_color(ctx, fg);
    graphics_draw_text(ctx, e->title, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(text_x, y + 3, text_w, 20),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);
    graphics_context_set_text_color(ctx, meta_fg);
    graphics_draw_text(ctx, e->meta, fonts_get_system_font(FONT_KEY_GOTHIC_14),
        GRect(text_x, y + 23, text_w, 16),
        GTextOverflowModeTrailingEllipsis, GTextAlignmentLeft, NULL);

    // Row divider (skip under a selected/inverted row)
    if (!selected) {
        graphics_context_set_stroke_color(ctx, GColorDarkGray);
        graphics_draw_line(ctx, GPoint(0, y + MENU_ROW_H - 1), GPoint(w, y + MENU_ROW_H - 1));
    }
}

static void hist_list_update(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);
    int w = bounds.size.w;
    int list_h = bounds.size.h - STATUS_H;

    // Background
    graphics_context_set_fill_color(ctx, C_SCREEN);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    // Status bar: "HISTORY" + divider
    graphics_context_set_text_color(ctx, C_ON_SCREEN);
    graphics_draw_text(ctx, "HISTORY", fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD),
        GRect(4, 1, w - 8, STATUS_H), GTextOverflowModeFill, GTextAlignmentLeft, NULL);
    draw_status_divider(ctx, bounds);

    for (int i = 0; i < s_merged_count; i++) {
        int y = STATUS_H + i * MENU_ROW_H - s_hist_scroll;
        if (y + MENU_ROW_H <= STATUS_H || y >= bounds.size.h) continue;  // offscreen
        draw_merged_row(ctx, &s_merged[i], y, w, i == s_hist_sel);
    }

    // Scroll indicator on the far right edge
    int total = s_merged_count * MENU_ROW_H;
    if (total > list_h) {
        int knob_h = list_h * list_h / total;
        if (knob_h < 8) knob_h = 8;
        int knob_y = STATUS_H + (list_h - knob_h) * s_hist_scroll / (total - list_h);
        graphics_context_set_fill_color(ctx, GColorLightGray);
        graphics_fill_rect(ctx, GRect(w - 2, knob_y, 2, knob_h), 0, GCornerNone);
    }
}

// Keep the selected row fully visible.
static void hist_scroll_to_selection(int visible_h) {
    int top = s_hist_sel * MENU_ROW_H;
    int bot = top + MENU_ROW_H;
    if (top < s_hist_scroll) s_hist_scroll = top;
    else if (bot > s_hist_scroll + visible_h) s_hist_scroll = bot - visible_h;
}

static void hist_up_click(ClickRecognizerRef rec, void *ctx) {
    if (s_hist_sel > 0) s_hist_sel--;
    hist_scroll_to_selection(layer_get_bounds(s_hist_list_layer).size.h - STATUS_H);
    layer_mark_dirty(s_hist_list_layer);
}

static void hist_down_click(ClickRecognizerRef rec, void *ctx) {
    if (s_hist_sel < s_merged_count - 1) s_hist_sel++;
    hist_scroll_to_selection(layer_get_bounds(s_hist_list_layer).size.h - STATUS_H);
    layer_mark_dirty(s_hist_list_layer);
}

static void hist_select_click(ClickRecognizerRef rec, void *ctx) {
    merged_item_open(s_hist_sel);
}

static void hist_list_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_UP,     hist_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN,   hist_down_click);
    window_single_click_subscribe(BUTTON_ID_SELECT, hist_select_click);
}

static void hist_start_dictation_cb(void *ctx) {
    if (!connection_service_peek_pebble_app_connection()) {
        set_status("Connect phone first");
        return;
    }
    dictation_session_start(s_dictation_session);
}

static void hist_empty_select_click(ClickRecognizerRef rec, void *ctx) {
    window_stack_pop(true);
    app_timer_register(300, hist_start_dictation_cb, NULL);
}

static void hist_empty_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_SELECT, hist_empty_select_click);
}

static void history_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);
    // History is full-width (no action bar) per handoff.
    int content_w = b.size.w;

    window_set_background_color(window, C_SCREEN);
    merged_rebuild();

    if (s_merged_count == 0) {
        // Status title for the empty state
        s_hist_title_layer = text_layer_create(GRect(4, 1, content_w - 8, STATUS_H));
        text_layer_set_background_color(s_hist_title_layer, GColorClear);
        text_layer_set_text_color(s_hist_title_layer, C_ON_SCREEN);
        text_layer_set_font(s_hist_title_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
        text_layer_set_text(s_hist_title_layer, "HISTORY");
        layer_add_child(root, text_layer_get_layer(s_hist_title_layer));

        s_hist_empty_label = text_layer_create(GRect(0, b.size.h / 2 - 20, content_w, 32));
        text_layer_set_background_color(s_hist_empty_label, GColorClear);
        text_layer_set_text_color(s_hist_empty_label, C_ON_SCREEN);
        text_layer_set_font(s_hist_empty_label,
                            fonts_get_system_font(FONT_KEY_GOTHIC_28_BOLD));
        text_layer_set_text_alignment(s_hist_empty_label, GTextAlignmentCenter);
        text_layer_set_text(s_hist_empty_label, "NO ENTRIES");
        layer_add_child(root, text_layer_get_layer(s_hist_empty_label));

        s_hist_empty_hint = text_layer_create(GRect(0, b.size.h - 28, content_w, 28));
        text_layer_set_background_color(s_hist_empty_hint, GColorClear);
        text_layer_set_text_color(s_hist_empty_hint, C_ON_SCREEN);
        text_layer_set_font(s_hist_empty_hint,
                            fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
        text_layer_set_text_alignment(s_hist_empty_hint, GTextAlignmentCenter);
        text_layer_set_text(s_hist_empty_hint, "PRESS TO SPEAK");
        layer_add_child(root, text_layer_get_layer(s_hist_empty_hint));
        window_set_click_config_provider(window, hist_empty_click_config);
        return;
    }

    s_hist_row_w  = content_w;
    s_hist_sel    = 0;
    s_hist_scroll = 0;
    s_hist_list_layer = layer_create(GRect(0, 0, content_w, b.size.h));
    layer_set_update_proc(s_hist_list_layer, hist_list_update);
    layer_add_child(root, s_hist_list_layer);
    window_set_click_config_provider(window, hist_list_click_config);
}

static void history_window_unload(Window *window) {
    if (s_hist_title_layer)  { text_layer_destroy(s_hist_title_layer);  s_hist_title_layer = NULL; }
    if (s_hist_list_layer)   { layer_destroy(s_hist_list_layer);        s_hist_list_layer = NULL; }
    if (s_hist_empty_label) {
        text_layer_destroy(s_hist_empty_label);
        s_hist_empty_label = NULL;
        text_layer_destroy(s_hist_empty_hint);
        s_hist_empty_hint = NULL;
    }
}

// ============================================================================
// REMINDER DETAIL WINDOW
// ============================================================================

static void rem_detail_up_click(ClickRecognizerRef rec, void *ctx) {
    s_rem_scroll_offset -= RESP_SCROLL_STEP;
    if (s_rem_scroll_offset < 0) s_rem_scroll_offset = 0;
    scroll_layer_set_content_offset(s_rem_detail_scroll,
        GPoint(0, -s_rem_scroll_offset), true);
}

static void rem_detail_down_click(ClickRecognizerRef rec, void *ctx) {
    GSize cs = scroll_layer_get_content_size(s_rem_detail_scroll);
    GRect fr = layer_get_frame(scroll_layer_get_layer(s_rem_detail_scroll));
    int16_t max_scroll = cs.h - fr.size.h;
    if (max_scroll < 0) max_scroll = 0;
    s_rem_scroll_offset += RESP_SCROLL_STEP;
    if (s_rem_scroll_offset > max_scroll) s_rem_scroll_offset = max_scroll;
    scroll_layer_set_content_offset(s_rem_detail_scroll,
        GPoint(0, -s_rem_scroll_offset), true);
}

static void rem_detail_select_click(ClickRecognizerRef rec, void *ctx) {
    if (!s_rem_confirm) {
        // First press: ask for confirmation
        s_rem_confirm = true;
        strncpy(s_rem_header_buf, "Delete?", sizeof(s_rem_header_buf) - 1);
        text_layer_set_text(s_rem_detail_header, s_rem_header_buf);
        strncpy(s_rem_hint_buf, "OK?", sizeof(s_rem_hint_buf) - 1);
        text_layer_set_text_color(s_rem_detail_hint, C_ON_SCREEN);
        text_layer_set_text(s_rem_detail_hint, s_rem_hint_buf);
    } else {
        // Second press: perform delete then pop back (appear handler refreshes list)
        reminders_delete(s_rem_detail_idx);
        window_stack_pop(true);
    }
}

static void rem_detail_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_UP,     rem_detail_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN,   rem_detail_down_click);
    window_single_click_subscribe(BUTTON_ID_SELECT, rem_detail_select_click);
}

static void rem_detail_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);
    int content_w = content_area_w(b);

    window_set_background_color(window, C_SCREEN);

    strncpy(s_rem_header_buf, "NOTE", sizeof(s_rem_header_buf) - 1);
    s_rem_detail_header = text_layer_create(GRect(4, 1, content_w - 8, STATUS_H));
    text_layer_set_background_color(s_rem_detail_header, GColorClear);
    text_layer_set_text_color(s_rem_detail_header, C_ON_SCREEN);
    text_layer_set_font(s_rem_detail_header,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_overflow_mode(s_rem_detail_header, GTextOverflowModeTrailingEllipsis);
    text_layer_set_text(s_rem_detail_header, s_rem_header_buf);
    layer_add_child(root, text_layer_get_layer(s_rem_detail_header));

    strncpy(s_rem_hint_buf, "DEL", sizeof(s_rem_hint_buf) - 1);
    s_rem_detail_hint = text_layer_create(GRect(content_w - 40, b.size.h * 47 / 100, 36, 20));
    text_layer_set_background_color(s_rem_detail_hint, GColorClear);
    text_layer_set_text_color(s_rem_detail_hint, C_ON_SCREEN);
    text_layer_set_font(s_rem_detail_hint,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text_alignment(s_rem_detail_hint, GTextAlignmentRight);
    text_layer_set_text(s_rem_detail_hint, s_rem_hint_buf);
    layer_add_child(root, text_layer_get_layer(s_rem_detail_hint));

    int si = s_rem_count - 1 - s_rem_detail_idx;
    s_rem_scroll_offset = 0;
    GRect scroll_frame = GRect(0, STATUS_H + 2, content_w, b.size.h - STATUS_H - 2);
    s_rem_detail_scroll = scroll_layer_create(scroll_frame);
    layer_add_child(root, scroll_layer_get_layer(s_rem_detail_scroll));

    int inner_w = content_w - 8;
    s_rem_detail_content = text_layer_create(GRect(4, 4, inner_w, 2000));
    text_layer_set_background_color(s_rem_detail_content, GColorClear);
    text_layer_set_text_color(s_rem_detail_content, C_ON_SCREEN);
    text_layer_set_font(s_rem_detail_content,
                        fonts_get_system_font(FONT_KEY_GOTHIC_24));
    text_layer_set_overflow_mode(s_rem_detail_content, GTextOverflowModeWordWrap);
    text_layer_set_text(s_rem_detail_content, s_rem_text[si]);
    scroll_layer_add_child(s_rem_detail_scroll,
                           text_layer_get_layer(s_rem_detail_content));

    GSize ts = text_layer_get_content_size(s_rem_detail_content);
    scroll_layer_set_content_size(s_rem_detail_scroll, GSize(inner_w, ts.h + 8));

    window_set_click_config_provider(window, rem_detail_click_config);
}

static void rem_detail_window_unload(Window *window) {
    text_layer_destroy(s_rem_detail_header);  s_rem_detail_header  = NULL;
    text_layer_destroy(s_rem_detail_hint);    s_rem_detail_hint    = NULL;
    text_layer_destroy(s_rem_detail_content); s_rem_detail_content = NULL;
    scroll_layer_destroy(s_rem_detail_scroll); s_rem_detail_scroll  = NULL;
}

// ============================================================================
// WINDOW PUSH HELPERS
// ============================================================================

static void home_window_push(void) {
    s_home_window = window_create();
    window_set_window_handlers(s_home_window, (WindowHandlers) {
        .load   = home_window_load,
        .unload = home_window_unload,
    });
    window_stack_push(s_home_window, true);
}

static void confirm_window_push(void) {
    if (s_confirm_window) {
        window_destroy(s_confirm_window);
        s_confirm_window = NULL;
    }
    s_confirm_window = window_create();
    window_set_window_handlers(s_confirm_window, (WindowHandlers) {
        .load   = confirm_window_load,
        .unload = confirm_window_unload,
    });
    window_stack_push(s_confirm_window, true);
    // Ask phone to classify in parallel so the target label can be shown
    if (connection_service_peek_pebble_app_connection()) {
        appmsg_classify_note(s_note_buf);
    }
}

static void response_window_push(void) {
    if (s_response_window) {
        window_destroy(s_response_window);
        s_response_window = NULL;
    }
    s_response_window = window_create();
    window_set_window_handlers(s_response_window, (WindowHandlers) {
        .load   = response_window_load,
        .unload = response_window_unload,
    });
    window_stack_push(s_response_window, true);
}

static void history_window_push(void) {
    history_load_from_persist();
    reminders_load_from_persist();
    if (s_history_window) {
        window_destroy(s_history_window);
        s_history_window = NULL;
    }
    s_history_window = window_create();
    window_set_window_handlers(s_history_window, (WindowHandlers) {
        .load   = history_window_load,
        .unload = history_window_unload,
    });
    window_stack_push(s_history_window, true);
}

static void detail_window_push(int idx) {
    s_detail_idx = idx;
    if (s_detail_window) {
        window_destroy(s_detail_window);
        s_detail_window = NULL;
    }
    s_detail_window = window_create();
    window_set_window_handlers(s_detail_window, (WindowHandlers) {
        .load   = detail_window_load,
        .unload = detail_window_unload,
    });
    window_stack_push(s_detail_window, true);
}

static void success_window_push(int dest) {
    s_success_dest = dest;
    snprintf(s_success_quote, sizeof(s_success_quote), "\"%.58s\"", s_note_buf);
    if (s_success_window) {
        window_destroy(s_success_window);
        s_success_window = NULL;
    }
    s_success_window = window_create();
    window_set_window_handlers(s_success_window, (WindowHandlers) {
        .load   = success_window_load,
        .unload = success_window_unload,
    });
    window_stack_push(s_success_window, true);
}

static void rem_detail_window_push(int display_idx) {
    s_rem_detail_idx = display_idx;
    s_rem_confirm    = false;
    if (s_rem_detail_window) {
        window_destroy(s_rem_detail_window);
        s_rem_detail_window = NULL;
    }
    s_rem_detail_window = window_create();
    window_set_window_handlers(s_rem_detail_window, (WindowHandlers) {
        .load   = rem_detail_window_load,
        .unload = rem_detail_window_unload,
    });
    window_stack_push(s_rem_detail_window, true);
}

// ============================================================================
// APP LIFECYCLE
// ============================================================================

#ifdef DEBUG_SEED
static void debug_seed(void) {
    // Seed each store independently so a leftover store from a prior run
    // doesn't suppress seeding of the other.
    if (s_history_count == 0) {
        history_save_item("Draft Q3 deck for Sarah",
                          "Sure — quick outline:\n1. Vision\n2. Metrics\n3. The ask", DEST_AI);
        history_save_item("Renew the domain", NULL, DEST_TODOIST);
    }
    if (s_rem_count == 0) {
        reminders_add("Buy oat milk");
        reminders_add("Voice memo widget idea");
    }
}
#endif

static void init(void) {
    // AppMessage — register before open
    app_message_register_inbox_received(inbox_received_callback);
    app_message_register_inbox_dropped(inbox_dropped_callback);
    app_message_register_outbox_failed(outbox_failed_callback);
    app_message_open(512, 512);

    // Dictation session (buffer 400 bytes)
    s_dictation_session = dictation_session_create(
        NOTE_BUF_SIZE, dictation_callback, NULL);
    dictation_session_enable_confirmation(s_dictation_session, false);
    dictation_session_enable_error_dialogs(s_dictation_session, true);

    // Load persistent data
    history_load_from_persist();
    reminders_load_from_persist();

#ifdef DEBUG_SEED
    debug_seed();
#endif

    // Push home window
    home_window_push();

    // If launched via quick launch (long-press from watch face), auto-start dictation
    if (launch_reason() == APP_LAUNCH_QUICK_LAUNCH) {
        app_timer_register(400, hist_start_dictation_cb, NULL);
    }
}

static void deinit(void) {
    if (s_dictation_session) {
        dictation_session_destroy(s_dictation_session);
        s_dictation_session = NULL;
    }
    if (s_success_window)    { window_destroy(s_success_window);    }
    if (s_rem_detail_window) { window_destroy(s_rem_detail_window); }
    if (s_detail_window)     { window_destroy(s_detail_window);     }
    if (s_history_window)    { window_destroy(s_history_window);    }
    if (s_confirm_window)    { window_destroy(s_confirm_window);    }
    if (s_response_window)   { window_destroy(s_response_window);   }
    if (s_home_window)       { window_destroy(s_home_window);       }
    app_message_deregister_callbacks();
}

int main(void) {
    init();
    app_event_loop();
    deinit();
    return 0;
}
