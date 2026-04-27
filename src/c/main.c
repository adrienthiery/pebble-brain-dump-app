#include <pebble.h>

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
#define PERSIST_HISTORY_VERSION_KEY  0
#define PERSIST_HISTORY_VERSION      3   // bump when HistoryEntry layout changes
#define PERSIST_HISTORY_COUNT        1
#define PERSIST_HISTORY_BASE        10   // entries at 10..17

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

// Destination bitmask bits (must match pkjs DEST_MASK)
#define DEST_BIT_TASKS   (1 << DEST_TASKS)
#define DEST_BIT_NOTION  (1 << DEST_NOTION)
#define DEST_BIT_AI      (1 << DEST_AI)
#define DEST_BIT_WEBHOOK (1 << DEST_WEBHOOK)

// Color aliases — compile away on B&W platforms
#ifdef PBL_COLOR
  #define C_STATUS   GColorCadetBlue
  #define C_HINT     GColorDarkGray
  #define C_ACCENT   GColorOrange
  #define C_MIC      GColorWhite
  #define C_HEADER   GColorLightGray
#else
  #define C_STATUS   GColorWhite
  #define C_HINT     GColorWhite
  #define C_ACCENT   GColorWhite
  #define C_MIC      GColorWhite
  #define C_HEADER   GColorWhite
#endif

// ============================================================================
// DATA TYPES
// ============================================================================

typedef struct __attribute__((packed)) {
    char  short_text[HISTORY_SHORT_LEN];
    char  full_text[HISTORY_FULL_LEN];
    uint8_t  dest;
    uint32_t timestamp;
} HistoryEntry;

typedef struct __attribute__((packed)) {
    char     text[REMINDER_TEXT_LEN];
    uint32_t timestamp;
} ReminderEntry;

// ============================================================================
// GLOBAL STATE
// ============================================================================

// --- Windows ---
static Window *s_home_window;
static Window *s_response_window;
static Window *s_history_window;
static Window *s_detail_window;
static Window *s_reminders_window;
static Window *s_rem_detail_window;

// --- Home window layers ---
static Layer     *s_canvas_layer;
static TextLayer *s_status_layer;
static TextLayer *s_hint_up_layer;
static TextLayer *s_hint_select_layer;
static TextLayer *s_hint_down_layer;

// Home layout constants
#define HOME_BANNER_W 58
// Round banner is drawn as an arc with graphics_fill_radial, so it follows
// the bezel curvature natively — no horizontal/vertical inset needed.
#define HOME_BANNER_INSET_X 0
#define HOME_BANNER_INSET_Y 0

// --- Response window layers ---
static TextLayer  *s_resp_header_layer;
static ScrollLayer *s_resp_scroll_layer;
static TextLayer  *s_resp_content_layer;
static TextLayer  *s_resp_hint_layer;

// --- History window ---
static SimpleMenuLayer  *s_history_menu_layer;
static SimpleMenuSection s_history_section;
static SimpleMenuItem    s_history_items[MAX_HISTORY];
// Empty state (shown when no history)
static Layer     *s_hist_empty_icon;
static TextLayer *s_hist_empty_label;
static TextLayer *s_hist_empty_hint;

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

// --- Reminders ---
static SimpleMenuLayer  *s_rem_menu_layer;
static SimpleMenuSection s_rem_section;
static SimpleMenuItem    s_rem_items[MAX_REMINDERS];
static Layer     *s_rem_empty_icon;
static TextLayer *s_rem_empty_label;
static TextLayer *s_rem_empty_hint;
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
static void response_window_push(void);
static void history_window_push(void);
static void detail_window_push(int idx);
static void reminders_window_push(void);
static void rem_detail_window_push(int display_idx);

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
        default:           return "?";
    }
}

static void set_status(const char *msg) {
    strncpy(s_status_buf, msg, STATUS_BUF_SIZE - 1);
    s_status_buf[STATUS_BUF_SIZE - 1] = '\0';
    if (s_status_layer) {
        text_layer_set_text(s_status_layer, s_status_buf);
    }
}

// ============================================================================
// PERSISTENT HISTORY
// ============================================================================

// Scratch buffers for persist read/write — kept in BSS (not stack) to avoid
// stack overflow. HistoryEntry is 653 bytes; allocating two on the stack
// simultaneously (history_save_item → history_load_from_persist) would consume
// ~1.3 KB of the ~2.5 KB app stack and trigger a hard fault.
static HistoryEntry  s_hist_entry_buf;
static ReminderEntry s_rem_entry_buf;

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
        if (persist_read_data(key, &s_hist_entry_buf, sizeof(s_hist_entry_buf)) < 0) continue;
        strncpy(s_history_short[s_history_count], s_hist_entry_buf.short_text, HISTORY_SHORT_LEN - 1);
        strncpy(s_history_full [s_history_count], s_hist_entry_buf.full_text,  HISTORY_FULL_LEN  - 1);
        s_history_dest[s_history_count] = s_hist_entry_buf.dest;
        s_history_ts  [s_history_count] = s_hist_entry_buf.timestamp;
        s_history_count++;
    }
}

// question → short_text (list label); response → full_text (detail view).
// Pass NULL for response to use question as both (non-AI destinations).
static void history_save_item(const char *question, const char *response, int dest) {
    int stored = persist_exists(PERSIST_HISTORY_COUNT)
                 ? persist_read_int(PERSIST_HISTORY_COUNT) : 0;
    int slot = stored % MAX_HISTORY;

    memset(&s_hist_entry_buf, 0, sizeof(s_hist_entry_buf));
    strncpy(s_hist_entry_buf.short_text, question,           HISTORY_SHORT_LEN - 1);
    strncpy(s_hist_entry_buf.full_text,  response ? response : question, HISTORY_FULL_LEN - 1);
    s_hist_entry_buf.dest      = (uint8_t)dest;
    s_hist_entry_buf.timestamp = (uint32_t)time(NULL);

    persist_write_data((uint32_t)(PERSIST_HISTORY_BASE + slot), &s_hist_entry_buf, sizeof(s_hist_entry_buf));
    persist_write_int(PERSIST_HISTORY_COUNT, stored + 1);

    history_load_from_persist();
}

// Update the full_text of the most recently saved entry (for follow-up responses).
static void history_update_latest(const char *response) {
    int stored = persist_exists(PERSIST_HISTORY_COUNT)
                 ? persist_read_int(PERSIST_HISTORY_COUNT) : 0;
    if (stored == 0) return;
    int slot = ((stored - 1) % MAX_HISTORY + MAX_HISTORY) % MAX_HISTORY;
    uint32_t key = (uint32_t)(PERSIST_HISTORY_BASE + slot);
    if (persist_read_data(key, &s_hist_entry_buf, sizeof(s_hist_entry_buf)) < 0) return;
    strncpy(s_hist_entry_buf.full_text, response, HISTORY_FULL_LEN - 1);
    persist_write_data(key, &s_hist_entry_buf, sizeof(s_hist_entry_buf));
    // Also update in-memory display (most-recent is at index 0)
    if (s_history_count > 0) {
        strncpy(s_history_full[0], response, HISTORY_FULL_LEN - 1);
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

    // ROUTING_DONE — JS has decided destination; update status while waiting
    Tuple *routing_t = dict_find(iter, MESSAGE_KEY_ROUTING_DONE);
    if (routing_t) {
        int dest = (int)routing_t->value->int32;
        if (dest == DEST_AI) {
            set_status("Waiting for answer...");
        } else {
            set_status("Taking action...");
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
        if (s_dest_mask == 0 && !is_followup) {
            // No cloud services configured — save locally as a reminder
            reminders_add(s_note_buf);
            set_status("Saved to reminders");
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
// DRAW — BRAIN ICON
// ============================================================================

// Brain outline traced from brain-solid-svgrepo-com.svg (viewBox 0 0 32 32).
// 87 points flattened from cubic beziers, scaled to ±15 units at scale=100.
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

static void draw_brain_icon(GContext *ctx, GPoint center, int scale) {
    int cx = center.x;
    int cy = center.y;

    graphics_context_set_stroke_color(ctx, C_MIC);
    graphics_context_set_stroke_width(ctx, 2);

    // Draw the outline polygon (closes back to point 0)
    for (int i = 0; i < BRAIN_N; i++) {
        graphics_draw_line(ctx,
            GPoint(cx + BRAIN_PX[i]           * scale / 100, cy + BRAIN_PY[i]           * scale / 100),
            GPoint(cx + BRAIN_PX[(i+1)%BRAIN_N] * scale / 100, cy + BRAIN_PY[(i+1)%BRAIN_N] * scale / 100));
    }

    // Central fissure — vertical line through the notch at top and bottom
    graphics_context_set_stroke_width(ctx, 1);
    graphics_draw_line(ctx,
        GPoint(cx, cy - 13 * scale / 100),
        GPoint(cx, cy + 14 * scale / 100));
}

// ============================================================================
// DRAW — MICROPHONE ICON
// ============================================================================

// Mic proportions derived from microphone-342.svg (viewBox 0 0 90 90).
static void draw_mic_icon(GContext *ctx, GPoint center, int scale) {
    int bw = 18 * scale / 100;   // body width  (SVG: 18.7*2 → 9px half)
    int bh = 30 * scale / 100;   // body height (SVG: 60.738 / 2.03 scale)
    int br =  9 * scale / 100;   // corner radius

    // Body: filled rounded rect centred at `center`
    GRect body = GRect(center.x - bw / 2, center.y - bh / 2, bw, bh);
    graphics_context_set_fill_color(ctx, C_MIC);
    graphics_fill_rect(ctx, body, (uint16_t)br, GCornersAll);

    // Vertical stem — starts at body bottom
    graphics_context_set_stroke_color(ctx, C_MIC);
    graphics_context_set_stroke_width(ctx, 2);
    int stem_top    = center.y + bh / 2;
    int stem_bottom = stem_top + 6 * scale / 100;
    graphics_draw_line(ctx, GPoint(center.x, stem_top),
                            GPoint(center.x, stem_bottom));

    // Horizontal base (SVG: half-width = 5px at scale=100)
    int base_half = 5 * scale / 100;
    if (base_half < 2) base_half = 2;
    graphics_draw_line(ctx, GPoint(center.x - base_half, stem_bottom),
                            GPoint(center.x + base_half, stem_bottom));
}

// ============================================================================
// HOME WINDOW
// ============================================================================

static void canvas_update_proc(Layer *layer, GContext *ctx) {
    GRect bounds = layer_get_bounds(layer);

    // 1. Black background
    graphics_context_set_fill_color(ctx, GColorBlack);
    graphics_fill_rect(ctx, bounds, 0, GCornerNone);

    // 2. White crescent banner (drawn before icons so icons paint on top)
#ifdef PBL_ROUND
    // Crescent = screen ∩ complement(big circle).
    // Fill whole screen white, then stamp big black circle to the left — leaves
    // only the right crescent white.
    {
        int R = bounds.size.w / 2;
        graphics_context_set_fill_color(ctx, GColorWhite);
        graphics_fill_circle(ctx, GPoint(R, R), (uint16_t)R);
        graphics_context_set_fill_color(ctx, GColorBlack);
        graphics_fill_circle(ctx, GPoint(-R * 27 / 100, R), (uint16_t)(R * 150 / 100));
    }
#else
    {
        graphics_context_set_fill_color(ctx, GColorWhite);
        int banner_x = bounds.size.w - HOME_BANNER_W;
        graphics_fill_rect(ctx, GRect(banner_x, 0, HOME_BANNER_W, bounds.size.h), 0, GCornerNone);
    }
#endif

    int content_w = bounds.size.w - HOME_BANNER_W - HOME_BANNER_INSET_X;
    if (content_w < 20) content_w = bounds.size.w;
    int cx = content_w / 2;

    // 3. Brain + mic icons on top
    int brain_cx = cx;
    int brain_cy = bounds.size.h * 50 / 100;
    draw_brain_icon(ctx, GPoint(brain_cx, brain_cy), 150);
    draw_mic_icon(ctx, GPoint(brain_cx + 18, brain_cy + 14), 55);

    if (s_waiting_response) {
        graphics_context_set_fill_color(ctx, C_ACCENT);
        graphics_fill_circle(ctx, GPoint(bounds.size.w - 8, 8), 4);
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

static void home_down_click(ClickRecognizerRef rec, void *ctx) {
    reminders_window_push();
}

static void home_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_SELECT, home_select_click);
    window_single_click_subscribe(BUTTON_ID_UP,     home_up_click);
    window_single_click_subscribe(BUTTON_ID_DOWN,   home_down_click);
}

static void home_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);

    window_set_background_color(window, GColorBlack);

    // Canvas (full screen for mic icon)
    s_canvas_layer = layer_create(b);
    layer_set_update_proc(s_canvas_layer, canvas_update_proc);
    layer_add_child(root, s_canvas_layer);

    // Status line — centered in left content area
    int content_w = b.size.w - HOME_BANNER_W - HOME_BANNER_INSET_X;
    if (content_w < 20) content_w = b.size.w;
    int status_y = b.size.h / 2 + 36;
    s_status_layer = text_layer_create(GRect(4, status_y, content_w - 8, 20));
    text_layer_set_background_color(s_status_layer, GColorClear);
    text_layer_set_text_color(s_status_layer, C_STATUS);
    text_layer_set_font(s_status_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_status_layer, GTextAlignmentCenter);
    text_layer_set_text(s_status_layer, "Ready");
    layer_add_child(root, text_layer_get_layer(s_status_layer));

    // Right-side action labels — proportional Y aligns with physical buttons on all models.
    // Round: labels positioned inside the crescent (big-circle inner edge + small margin).
    // Rect:  labels inside the flat right banner.
    #define HINT_H      16
    #define HINT_UP_H   42
    #define HINT_DOWN_H 28
#ifdef PBL_ROUND
    // SELECT is at the widest part of the crescent (equator).
    // UP/DOWN are where the crescent narrows — shift them left to stay centred.
    #define HINT_X       (b.size.w * 68 / 100)
    #define HINT_X_EDGE  (b.size.w * 60 / 100)
    #define HINT_W       (b.size.w * 28 / 100)
#else
    #define HINT_X       (b.size.w - HOME_BANNER_W + 4)
    #define HINT_X_EDGE  HINT_X
    #define HINT_W       (HOME_BANNER_W - 8)
#endif
    int btn_up_y     = b.size.h * 18 / 100;   // UP:     ~18% from top
    int btn_select_y = b.size.h * 47 / 100;   // SELECT: ~47% from top
    int btn_down_y   = b.size.h * 75 / 100;   // DOWN:   ~75% from top

    s_hint_up_layer = text_layer_create(GRect(HINT_X_EDGE, btn_up_y - 12, HINT_W, HINT_UP_H));
    text_layer_set_background_color(s_hint_up_layer, GColorClear);
    text_layer_set_text_color(s_hint_up_layer, GColorBlack);
    text_layer_set_font(s_hint_up_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_hint_up_layer, GTextAlignmentCenter);
    text_layer_set_text(s_hint_up_layer, "Past\nsmart\nactions");
    layer_add_child(root, text_layer_get_layer(s_hint_up_layer));

    s_hint_select_layer = text_layer_create(GRect(HINT_X, btn_select_y, HINT_W, HINT_H));
    text_layer_set_background_color(s_hint_select_layer, GColorClear);
    text_layer_set_text_color(s_hint_select_layer, GColorRed);
    text_layer_set_font(s_hint_select_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_hint_select_layer, GTextAlignmentCenter);
    text_layer_set_text(s_hint_select_layer, "Dump");
    layer_add_child(root, text_layer_get_layer(s_hint_select_layer));

    s_hint_down_layer = text_layer_create(GRect(HINT_X_EDGE, btn_down_y - 6, HINT_W, HINT_DOWN_H));
    text_layer_set_background_color(s_hint_down_layer, GColorClear);
    text_layer_set_text_color(s_hint_down_layer, GColorBlack);
    text_layer_set_font(s_hint_down_layer, fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_hint_down_layer, GTextAlignmentCenter);
    text_layer_set_text(s_hint_down_layer, "Local\nnotes");
    layer_add_child(root, text_layer_get_layer(s_hint_down_layer));

    window_set_click_config_provider(window, home_click_config);

    strncpy(s_status_buf, "Ready", STATUS_BUF_SIZE - 1);
}

static void home_window_unload(Window *window) {
    layer_destroy(s_canvas_layer);            s_canvas_layer      = NULL;
    text_layer_destroy(s_status_layer);       s_status_layer      = NULL;
    text_layer_destroy(s_hint_up_layer);      s_hint_up_layer     = NULL;
    text_layer_destroy(s_hint_select_layer);  s_hint_select_layer = NULL;
    text_layer_destroy(s_hint_down_layer);    s_hint_down_layer   = NULL;
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

static void response_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);

    window_set_background_color(window, GColorBlack);

    // Header: truncated question
    s_resp_header_layer = text_layer_create(GRect(4, 2, b.size.w - 8, 28));
    text_layer_set_background_color(s_resp_header_layer, GColorClear);
    text_layer_set_text_color(s_resp_header_layer, C_HEADER);
    text_layer_set_font(s_resp_header_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_overflow_mode(s_resp_header_layer, GTextOverflowModeTrailingEllipsis);
    text_layer_set_text(s_resp_header_layer, s_note_buf);
    layer_add_child(root, text_layer_get_layer(s_resp_header_layer));

    // SELECT button label — right side, proportional Y for all models
    s_resp_hint_layer = text_layer_create(GRect(b.size.w - 52, b.size.h * 47 / 100, 50, 16));
    text_layer_set_background_color(s_resp_hint_layer, GColorClear);
    text_layer_set_text_color(s_resp_hint_layer, C_ACCENT);
    text_layer_set_font(s_resp_hint_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_resp_hint_layer, GTextAlignmentRight);
    text_layer_set_text(s_resp_hint_layer, "Reply");
    layer_add_child(root, text_layer_get_layer(s_resp_hint_layer));

    // Scrollable response content (full height minus header)
    int scroll_top  = 32;
    int scroll_h    = b.size.h - scroll_top;
    GRect scroll_frame = GRect(0, scroll_top, b.size.w, scroll_h);

    s_resp_scroll_offset = 0;
    s_resp_scroll_layer = scroll_layer_create(scroll_frame);
    layer_add_child(root, scroll_layer_get_layer(s_resp_scroll_layer));

    int content_w = b.size.w - 8;
    s_resp_content_layer = text_layer_create(GRect(4, 4, content_w, 2000));
    text_layer_set_background_color(s_resp_content_layer, GColorClear);
    text_layer_set_text_color(s_resp_content_layer, GColorWhite);
    text_layer_set_font(s_resp_content_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_18));
    text_layer_set_overflow_mode(s_resp_content_layer, GTextOverflowModeWordWrap);
    text_layer_set_text(s_resp_content_layer, s_conversation_buf);
    scroll_layer_add_child(s_resp_scroll_layer,
                           text_layer_get_layer(s_resp_content_layer));

    // Set content size to fit text
    GSize text_size = text_layer_get_content_size(s_resp_content_layer);
    scroll_layer_set_content_size(s_resp_scroll_layer,
        GSize(content_w, text_size.h + 8));

    window_set_click_config_provider(window, resp_click_config);
    s_response_open = true;
}

static void response_window_unload(Window *window) {
    text_layer_destroy(s_resp_header_layer);  s_resp_header_layer  = NULL;
    text_layer_destroy(s_resp_hint_layer);    s_resp_hint_layer    = NULL;
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

    window_set_background_color(window, GColorBlack);

    // Header: first question (truncated to fit)
    static char s_detail_header_buf[HISTORY_SHORT_LEN];
    strncpy(s_detail_header_buf, s_history_short[s_detail_idx], sizeof(s_detail_header_buf) - 1);
    s_detail_header_buf[sizeof(s_detail_header_buf) - 1] = '\0';

    s_detail_header_layer = text_layer_create(GRect(4, 2, b.size.w - 8, 20));
    text_layer_set_background_color(s_detail_header_layer, GColorClear);
    text_layer_set_text_color(s_detail_header_layer, C_HEADER);
    text_layer_set_font(s_detail_header_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_text(s_detail_header_layer, s_detail_header_buf);
    layer_add_child(root, text_layer_get_layer(s_detail_header_layer));

    // Scroll + content
    s_detail_scroll_offset = 0;
    GRect scroll_frame = GRect(0, 24, b.size.w, b.size.h - 24);
    s_detail_scroll_layer = scroll_layer_create(scroll_frame);
    layer_add_child(root, scroll_layer_get_layer(s_detail_scroll_layer));

    int content_w = b.size.w - 8;
    s_detail_content_layer = text_layer_create(GRect(4, 4, content_w, 2000));
    text_layer_set_background_color(s_detail_content_layer, GColorClear);
    text_layer_set_text_color(s_detail_content_layer, GColorWhite);
    text_layer_set_font(s_detail_content_layer,
                        fonts_get_system_font(FONT_KEY_GOTHIC_18));
    text_layer_set_overflow_mode(s_detail_content_layer, GTextOverflowModeWordWrap);
    text_layer_set_text(s_detail_content_layer, s_history_full[s_detail_idx]);
    scroll_layer_add_child(s_detail_scroll_layer,
                           text_layer_get_layer(s_detail_content_layer));

    GSize ts = text_layer_get_content_size(s_detail_content_layer);
    scroll_layer_set_content_size(s_detail_scroll_layer,
        GSize(content_w, ts.h + 8));

    window_set_click_config_provider(window, detail_click_config);
}

static void detail_window_unload(Window *window) {
    text_layer_destroy(s_detail_header_layer);   s_detail_header_layer  = NULL;
    text_layer_destroy(s_detail_content_layer);  s_detail_content_layer = NULL;
    scroll_layer_destroy(s_detail_scroll_layer); s_detail_scroll_layer  = NULL;
}

// ============================================================================
// HISTORY WINDOW
// ============================================================================

static void history_item_selected(int index, void *ctx) {
    if (index < 0 || index >= s_history_count) return;
    detail_window_push(index);
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

// Draw an inbox-tray icon for the empty history state
static void history_empty_icon_draw(Layer *layer, GContext *ctx) {
    GRect b = layer_get_bounds(layer);
    int cx = b.size.w / 2;
    int cy = b.size.h / 2;

#ifdef PBL_COLOR
    graphics_context_set_stroke_color(ctx, GColorCadetBlue);
    graphics_context_set_fill_color(ctx, GColorCadetBlue);
#else
    graphics_context_set_stroke_color(ctx, GColorWhite);
    graphics_context_set_fill_color(ctx, GColorWhite);
#endif
    graphics_context_set_stroke_width(ctx, 2);

    // Tray body: wide flat rectangle
    int tw = 48, th = 20;
    int ty = cy + 4;
    graphics_draw_line(ctx, GPoint(cx - tw/2, ty),          GPoint(cx - tw/2, ty + th)); // left
    graphics_draw_line(ctx, GPoint(cx - tw/2, ty + th),     GPoint(cx + tw/2, ty + th)); // bottom
    graphics_draw_line(ctx, GPoint(cx + tw/2, ty + th),     GPoint(cx + tw/2, ty));      // right
    // Tray lip (open top with indent)
    int lip = 14;
    graphics_draw_line(ctx, GPoint(cx - tw/2, ty),          GPoint(cx - lip, ty));  // left lip
    graphics_draw_line(ctx, GPoint(cx - lip,  ty),          GPoint(cx - lip, ty - 10)); // left inner
    graphics_draw_line(ctx, GPoint(cx - lip,  ty - 10),     GPoint(cx + lip, ty - 10)); // inner top
    graphics_draw_line(ctx, GPoint(cx + lip,  ty - 10),     GPoint(cx + lip, ty));  // right inner
    graphics_draw_line(ctx, GPoint(cx + lip,  ty),          GPoint(cx + tw/2, ty)); // right lip

    // Downward arrow above tray
    int ax = cx;
    int atop = ty - 24, abot = ty - 13;
    graphics_draw_line(ctx, GPoint(ax, atop), GPoint(ax, abot));
    graphics_draw_line(ctx, GPoint(ax - 6, abot - 7), GPoint(ax, abot));
    graphics_draw_line(ctx, GPoint(ax + 6, abot - 7), GPoint(ax, abot));
}

static void history_window_load(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);

    window_set_background_color(window, GColorBlack);

    if (s_history_count == 0) {
        // Full-screen empty state
        s_hist_empty_icon = layer_create(GRect(0, b.size.h / 2 - 52, b.size.w, 70));
        layer_set_update_proc(s_hist_empty_icon, history_empty_icon_draw);
        layer_add_child(root, s_hist_empty_icon);

        s_hist_empty_label = text_layer_create(
            GRect(0, b.size.h / 2 + 20, b.size.w, 30));
        text_layer_set_background_color(s_hist_empty_label, GColorClear);
        text_layer_set_text_color(s_hist_empty_label, GColorLightGray);
        text_layer_set_font(s_hist_empty_label,
                            fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
        text_layer_set_text_alignment(s_hist_empty_label, GTextAlignmentCenter);
        text_layer_set_text(s_hist_empty_label, "No smart actions yet");
        layer_add_child(root, text_layer_get_layer(s_hist_empty_label));

        s_hist_empty_hint = text_layer_create(
            GRect(0, b.size.h - 22, b.size.w, 22));
        text_layer_set_background_color(s_hist_empty_hint, GColorClear);
        text_layer_set_text_color(s_hist_empty_hint, GColorDarkGray);
        text_layer_set_font(s_hist_empty_hint,
                            fonts_get_system_font(FONT_KEY_GOTHIC_14));
        text_layer_set_text_alignment(s_hist_empty_hint, GTextAlignmentCenter);
        text_layer_set_text(s_hist_empty_hint, "Press [o] to record");
        layer_add_child(root, text_layer_get_layer(s_hist_empty_hint));
        window_set_click_config_provider(window, hist_empty_click_config);
        return;
    }

    // Build menu items
    for (int i = 0; i < s_history_count; i++) {
        s_history_items[i] = (SimpleMenuItem) {
            .title    = s_history_short[i],
            .subtitle = dest_short_name(s_history_dest[i]),
            .callback = history_item_selected,
        };
    }

    s_history_section = (SimpleMenuSection) {
        .title     = "Past smart actions",
        .items     = s_history_items,
        .num_items = (uint32_t)s_history_count,
    };

    s_history_menu_layer = simple_menu_layer_create(b, window,
                                                    &s_history_section, 1,
                                                    NULL);
#ifdef PBL_COLOR
    MenuLayer *ml = simple_menu_layer_get_menu_layer(s_history_menu_layer);
    menu_layer_set_normal_colors(ml, GColorBlack, GColorLightGray);
    menu_layer_set_highlight_colors(ml, GColorCobaltBlue, GColorWhite);
#endif
    layer_add_child(root, simple_menu_layer_get_layer(s_history_menu_layer));
}

static void history_window_unload(Window *window) {
    if (s_hist_empty_icon) {
        layer_destroy(s_hist_empty_icon);          s_hist_empty_icon  = NULL;
        text_layer_destroy(s_hist_empty_label);    s_hist_empty_label = NULL;
        text_layer_destroy(s_hist_empty_hint);     s_hist_empty_hint  = NULL;
    } else {
        simple_menu_layer_destroy(s_history_menu_layer);
        s_history_menu_layer = NULL;
    }
}

// ============================================================================
// REMINDERS WINDOWS
// ============================================================================

static void rem_item_selected(int index, void *ctx) {
    if (index < 0 || index >= s_rem_count) return;
    rem_detail_window_push(index);
}

static void rem_empty_select_click(ClickRecognizerRef rec, void *ctx) {
    window_stack_pop(true);
    app_timer_register(300, hist_start_dictation_cb, NULL);
}

static void rem_empty_click_config(void *ctx) {
    window_single_click_subscribe(BUTTON_ID_SELECT, rem_empty_select_click);
}

// Build (or rebuild) the reminders list content in-place.
// Called from both load and appear so the list refreshes after a delete.
static void reminders_list_build_ui(Window *window) {
    Layer *root = window_get_root_layer(window);
    GRect b = layer_get_bounds(root);

    // Remove previous content
    if (s_rem_menu_layer) {
        layer_remove_from_parent(simple_menu_layer_get_layer(s_rem_menu_layer));
        simple_menu_layer_destroy(s_rem_menu_layer);
        s_rem_menu_layer = NULL;
    }
    if (s_rem_empty_icon) {
        layer_remove_from_parent(s_rem_empty_icon);
        layer_destroy(s_rem_empty_icon);
        s_rem_empty_icon = NULL;
    }
    if (s_rem_empty_label) {
        layer_remove_from_parent(text_layer_get_layer(s_rem_empty_label));
        text_layer_destroy(s_rem_empty_label);
        s_rem_empty_label = NULL;
    }
    if (s_rem_empty_hint) {
        layer_remove_from_parent(text_layer_get_layer(s_rem_empty_hint));
        text_layer_destroy(s_rem_empty_hint);
        s_rem_empty_hint = NULL;
    }

    if (s_rem_count == 0) {
        // Full-screen empty state (reuse same inbox icon draw fn as history)
        s_rem_empty_icon = layer_create(GRect(0, b.size.h / 2 - 52, b.size.w, 70));
        layer_set_update_proc(s_rem_empty_icon, history_empty_icon_draw);
        layer_add_child(root, s_rem_empty_icon);

        s_rem_empty_label = text_layer_create(GRect(0, b.size.h / 2 + 20, b.size.w, 30));
        text_layer_set_background_color(s_rem_empty_label, GColorClear);
        text_layer_set_text_color(s_rem_empty_label, GColorLightGray);
        text_layer_set_font(s_rem_empty_label,
                            fonts_get_system_font(FONT_KEY_GOTHIC_18_BOLD));
        text_layer_set_text_alignment(s_rem_empty_label, GTextAlignmentCenter);
        text_layer_set_text(s_rem_empty_label, "No local notes");
        layer_add_child(root, text_layer_get_layer(s_rem_empty_label));

        s_rem_empty_hint = text_layer_create(GRect(0, b.size.h - 22, b.size.w, 22));
        text_layer_set_background_color(s_rem_empty_hint, GColorClear);
        text_layer_set_text_color(s_rem_empty_hint, GColorDarkGray);
        text_layer_set_font(s_rem_empty_hint,
                            fonts_get_system_font(FONT_KEY_GOTHIC_14));
        text_layer_set_text_alignment(s_rem_empty_hint, GTextAlignmentCenter);
        text_layer_set_text(s_rem_empty_hint, "Press [o] to dump a thought");
        layer_add_child(root, text_layer_get_layer(s_rem_empty_hint));

        window_set_click_config_provider(window, rem_empty_click_config);
    } else {
        // Show newest first: display_idx 0 = storage s_rem_count-1
        for (int i = 0; i < s_rem_count; i++) {
            int si = s_rem_count - 1 - i;
            s_rem_items[i] = (SimpleMenuItem) {
                .title    = s_rem_text[si],
                .callback = rem_item_selected,
            };
        }
        s_rem_section = (SimpleMenuSection) {
            .title     = "Recent local notes",
            .items     = s_rem_items,
            .num_items = (uint32_t)s_rem_count,
        };
        s_rem_menu_layer = simple_menu_layer_create(b, window,
                                                    &s_rem_section, 1, NULL);
#ifdef PBL_COLOR
        MenuLayer *ml = simple_menu_layer_get_menu_layer(s_rem_menu_layer);
        menu_layer_set_normal_colors(ml, GColorBlack, GColorLightGray);
        menu_layer_set_highlight_colors(ml, GColorCobaltBlue, GColorWhite);
#endif
        layer_add_child(root, simple_menu_layer_get_layer(s_rem_menu_layer));
    }
}

static void reminders_window_load(Window *window) {
    window_set_background_color(window, GColorBlack);
    reminders_list_build_ui(window);
}

static void reminders_window_appear(Window *window) {
    // Refresh after a delete (or any return from detail)
    reminders_list_build_ui(window);
}

static void reminders_window_unload(Window *window) {
    if (s_rem_menu_layer) {
        simple_menu_layer_destroy(s_rem_menu_layer);
        s_rem_menu_layer = NULL;
    }
    if (s_rem_empty_icon) {
        layer_destroy(s_rem_empty_icon);       s_rem_empty_icon  = NULL;
        text_layer_destroy(s_rem_empty_label); s_rem_empty_label = NULL;
        text_layer_destroy(s_rem_empty_hint);  s_rem_empty_hint  = NULL;
    }
}

// --- Reminder detail window ---

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
        strncpy(s_rem_hint_buf, "Confirm", sizeof(s_rem_hint_buf) - 1);
#ifdef PBL_COLOR
        text_layer_set_text_color(s_rem_detail_hint, GColorRed);
#endif
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

    window_set_background_color(window, GColorBlack);

    // Header
    strncpy(s_rem_header_buf, "Reminder", sizeof(s_rem_header_buf) - 1);
    s_rem_detail_header = text_layer_create(GRect(4, 2, b.size.w - 8, 20));
    text_layer_set_background_color(s_rem_detail_header, GColorClear);
    text_layer_set_text_color(s_rem_detail_header, C_HEADER);
    text_layer_set_font(s_rem_detail_header,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14_BOLD));
    text_layer_set_overflow_mode(s_rem_detail_header, GTextOverflowModeTrailingEllipsis);
    text_layer_set_text(s_rem_detail_header, s_rem_header_buf);
    layer_add_child(root, text_layer_get_layer(s_rem_detail_header));

    // SELECT button label — right side, proportional Y for all models
    strncpy(s_rem_hint_buf, "Delete", sizeof(s_rem_hint_buf) - 1);
    s_rem_detail_hint = text_layer_create(GRect(b.size.w - 52, b.size.h * 47 / 100, 50, 16));
    text_layer_set_background_color(s_rem_detail_hint, GColorClear);
    text_layer_set_text_color(s_rem_detail_hint, C_HINT);
    text_layer_set_font(s_rem_detail_hint,
                        fonts_get_system_font(FONT_KEY_GOTHIC_14));
    text_layer_set_text_alignment(s_rem_detail_hint, GTextAlignmentRight);
    text_layer_set_text(s_rem_detail_hint, s_rem_hint_buf);
    layer_add_child(root, text_layer_get_layer(s_rem_detail_hint));

    // Scrollable content (full height minus header)
    int si = s_rem_count - 1 - s_rem_detail_idx;
    s_rem_scroll_offset = 0;
    GRect scroll_frame = GRect(0, 24, b.size.w, b.size.h - 24);
    s_rem_detail_scroll = scroll_layer_create(scroll_frame);
    layer_add_child(root, scroll_layer_get_layer(s_rem_detail_scroll));

    int content_w = b.size.w - 8;
    s_rem_detail_content = text_layer_create(GRect(4, 4, content_w, 2000));
    text_layer_set_background_color(s_rem_detail_content, GColorClear);
    text_layer_set_text_color(s_rem_detail_content, GColorWhite);
    text_layer_set_font(s_rem_detail_content,
                        fonts_get_system_font(FONT_KEY_GOTHIC_18));
    text_layer_set_overflow_mode(s_rem_detail_content, GTextOverflowModeWordWrap);
    text_layer_set_text(s_rem_detail_content, s_rem_text[si]);
    scroll_layer_add_child(s_rem_detail_scroll,
                           text_layer_get_layer(s_rem_detail_content));

    GSize ts = text_layer_get_content_size(s_rem_detail_content);
    scroll_layer_set_content_size(s_rem_detail_scroll, GSize(content_w, ts.h + 8));

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
    history_load_from_persist();      // refresh before showing
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

static void reminders_window_push(void) {
    if (s_reminders_window) {
        window_destroy(s_reminders_window);
        s_reminders_window = NULL;
    }
    s_reminders_window = window_create();
    window_set_window_handlers(s_reminders_window, (WindowHandlers) {
        .load   = reminders_window_load,
        .appear = reminders_window_appear,
        .unload = reminders_window_unload,
    });
    window_stack_push(s_reminders_window, true);
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
    if (s_rem_detail_window) { window_destroy(s_rem_detail_window); }
    if (s_reminders_window)  { window_destroy(s_reminders_window);  }
    if (s_detail_window)     { window_destroy(s_detail_window);     }
    if (s_history_window)    { window_destroy(s_history_window);    }
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
