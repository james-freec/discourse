import { ajax } from "discourse/lib/ajax";
import {
  caretPosition,
  clipboardHelpers,
  determinePostReplaceSelection,
  inCodeBlock,
  safariHacksDisabled,
} from "discourse/lib/utilities";
import discourseComputed, {
  observes,
  on,
} from "discourse-common/utils/decorators";
import { emojiSearch, isSkinTonableEmoji } from "pretty-text/emoji";
import { emojiUrlFor, generateCookFunction } from "discourse/lib/text";
import { later, next, schedule, scheduleOnce } from "@ember/runloop";
import Component from "@ember/component";
import I18n from "I18n";
import Mousetrap from "mousetrap";
import { Promise } from "rsvp";
import { SKIP } from "discourse/lib/autocomplete";
import { categoryHashtagTriggerRule } from "discourse/lib/category-hashtags";
import deprecated from "discourse-common/lib/deprecated";
import discourseDebounce from "discourse-common/lib/debounce";
import { findRawTemplate } from "discourse-common/lib/raw-templates";
import { getRegister } from "discourse-common/lib/get-owner";
import { isEmpty } from "@ember/utils";
import { isTesting } from "discourse-common/config/environment";
import { linkSeenHashtags } from "discourse/lib/link-hashtags";
import { linkSeenMentions } from "discourse/lib/link-mentions";
import { loadOneboxes } from "discourse/lib/load-oneboxes";
import loadScript from "discourse/lib/load-script";
import { resolveCachedShortUrls } from "pretty-text/upload-short-url";
import { search as searchCategoryTag } from "discourse/lib/category-tag-search";
import { inject as service } from "@ember/service";
import showModal from "discourse/lib/show-modal";
import { siteDir } from "discourse/lib/text-direction";
import toMarkdown from "discourse/lib/to-markdown";
import { translations } from "pretty-text/emoji/data";
import { wantsNewWindow } from "discourse/lib/intercept-click";
import { action } from "@ember/object";

// Our head can be a static string or a function that returns a string
// based on input (like for numbered lists).
function getHead(head, prev) {
  if (typeof head === "string") {
    return [head, head.length];
  } else {
    return getHead(head(prev));
  }
}

function getButtonLabel(labelKey, defaultLabel) {
  // use the Font Awesome icon if the label matches the default
  return I18n.t(labelKey) === defaultLabel ? null : labelKey;
}

const OP = {
  NONE: 0,
  REMOVED: 1,
  ADDED: 2,
};

const FOUR_SPACES_INDENT = "4-spaces-indent";

let _createCallbacks = [];

const isInside = (text, regex) => {
  const matches = text.match(regex);
  return matches && matches.length % 2;
};

class Toolbar {
  constructor(opts) {
    const { siteSettings } = opts;
    this.shortcuts = {};
    this.context = null;

    this.groups = [
      { group: "fontStyles", buttons: [] },
      { group: "insertions", buttons: [] },
      { group: "extras", buttons: [] },
    ];

    this.addButton({
      id: "bold",
      group: "fontStyles",
      icon: "bold",
      label: getButtonLabel("composer.bold_label", "B"),
      shortcut: "B",
      preventFocus: true,
      trimLeading: true,
      perform: (e) => e.applySurround("**", "**", "bold_text"),
    });

    this.addButton({
      id: "italic",
      group: "fontStyles",
      icon: "italic",
      label: getButtonLabel("composer.italic_label", "I"),
      shortcut: "I",
      preventFocus: true,
      trimLeading: true,
      perform: (e) => e.applySurround("*", "*", "italic_text"),
    });

    if (opts.showLink) {
      this.addButton({
        id: "link",
        group: "insertions",
        shortcut: "K",
        preventFocus: true,
        trimLeading: true,
        sendAction: (event) => this.context.send("showLinkModal", event),
      });
    }

    this.addButton({
      id: "blockquote",
      group: "insertions",
      icon: "quote-right",
      shortcut: "Shift+9",
      preventFocus: true,
      perform: (e) =>
        e.applyList("> ", "blockquote_text", {
          applyEmptyLines: true,
          multiline: true,
        }),
    });

    this.addButton({
      id: "code",
      group: "insertions",
      shortcut: "E",
      preventFocus: true,
      trimLeading: true,
      action: (...args) => this.context.send("formatCode", args),
    });

    this.addButton({
      id: "bullet",
      group: "extras",
      icon: "list-ul",
      shortcut: "Shift+8",
      title: "composer.ulist_title",
      preventFocus: true,
      perform: (e) => e.applyList("* ", "list_item"),
    });

    this.addButton({
      id: "list",
      group: "extras",
      icon: "list-ol",
      shortcut: "Shift+7",
      title: "composer.olist_title",
      preventFocus: true,
      perform: (e) =>
        e.applyList(
          (i) => (!i ? "1. " : `${parseInt(i, 10) + 1}. `),
          "list_item"
        ),
    });

    if (siteSettings.support_mixed_text_direction) {
      this.addButton({
        id: "toggle-direction",
        group: "extras",
        icon: "exchange-alt",
        shortcut: "Shift+6",
        title: "composer.toggle_direction",
        preventFocus: true,
        perform: (e) => e.toggleDirection(),
      });
    }

    this.groups[this.groups.length - 1].lastGroup = true;
  }

  addButton(button) {
    const g = this.groups.findBy("group", button.group);
    if (!g) {
      throw new Error(`Couldn't find toolbar group ${button.group}`);
    }

    const createdButton = {
      id: button.id,
      tabindex: button.tabindex || "-1",
      className: button.className || button.id,
      label: button.label,
      icon: button.label ? null : button.icon || button.id,
      action: button.action || ((a) => this.context.send("toolbarButton", a)),
      perform: button.perform || function () {},
      trimLeading: button.trimLeading,
      popupMenu: button.popupMenu || false,
      preventFocus: button.preventFocus || false,
    };

    if (button.sendAction) {
      createdButton.sendAction = button.sendAction;
    }

    const title = I18n.t(button.title || `composer.${button.id}_title`);
    if (button.shortcut) {
      const mac = /Mac|iPod|iPhone|iPad/.test(navigator.platform);
      const mod = mac ? "Meta" : "Ctrl";
      let shortcutTitle = `${mod}+${button.shortcut}`;

      // Mac users are used to glyphs for shortcut keys
      if (mac) {
        shortcutTitle = shortcutTitle
          .replace("Shift", "\u21E7")
          .replace("Meta", "\u2318")
          .replace("Alt", "\u2325")
          .replace(/\+/g, "");
      } else {
        shortcutTitle = shortcutTitle
          .replace("Shift", I18n.t("shortcut_modifier_key.shift"))
          .replace("Ctrl", I18n.t("shortcut_modifier_key.ctrl"))
          .replace("Alt", I18n.t("shortcut_modifier_key.alt"));
      }

      createdButton.title = `${title} (${shortcutTitle})`;

      this.shortcuts[`${mod}+${button.shortcut}`.toLowerCase()] = createdButton;
    } else {
      createdButton.title = title;
    }

    if (button.unshift) {
      g.buttons.unshift(createdButton);
    } else {
      g.buttons.push(createdButton);
    }
  }
}

export function addToolbarCallback(func) {
  _createCallbacks.push(func);
}
export function clearToolbarCallbacks() {
  _createCallbacks = [];
}

export function onToolbarCreate(func) {
  deprecated("`onToolbarCreate` is deprecated, use the plugin api instead.");
  addToolbarCallback(func);
}

export default Component.extend({
  classNames: ["d-editor"],
  ready: false,
  lastSel: null,
  _mouseTrap: null,
  showLink: true,
  emojiPickerIsActive: false,
  emojiStore: service("emoji-store"),
  isEditorFocused: false,
  processPreview: true,

  @discourseComputed("placeholder")
  placeholderTranslated(placeholder) {
    if (placeholder) {
      return I18n.t(placeholder);
    }
    return null;
  },

  _readyNow() {
    this.set("ready", true);

    if (this.autofocus) {
      this.element.querySelector("textarea").focus();
    }
  },

  init() {
    this._super(...arguments);

    this.register = getRegister(this);
  },

  didInsertElement() {
    this._super(...arguments);

    const $editorInput = $(this.element.querySelector(".d-editor-input"));
    this._applyEmojiAutocomplete($editorInput);
    this._applyCategoryHashtagAutocomplete($editorInput);

    scheduleOnce("afterRender", this, this._readyNow);

    this._mouseTrap = new Mousetrap(
      this.element.querySelector(".d-editor-input")
    );
    const shortcuts = this.get("toolbar.shortcuts");

    Object.keys(shortcuts).forEach((sc) => {
      const button = shortcuts[sc];
      this._mouseTrap.bind(sc, () => {
        button.action(button);
        return false;
      });
    });

    // disable clicking on links in the preview
    $(this.element.querySelector(".d-editor-preview")).on(
      "click.preview",
      (e) => {
        if (wantsNewWindow(e)) {
          return;
        }
        const $target = $(e.target);
        if ($target.is("a.mention")) {
          this.appEvents.trigger(
            "click.discourse-preview-user-card-mention",
            $target
          );
        }
        if ($target.is("a.mention-group")) {
          this.appEvents.trigger(
            "click.discourse-preview-group-card-mention-group",
            $target
          );
        }
        if ($target.is("a")) {
          e.preventDefault();
          return false;
        }
      }
    );

    if (this.composerEvents) {
      this.appEvents.on("composer:insert-block", this, "_insertBlock");
      this.appEvents.on("composer:insert-text", this, "_insertText");
      this.appEvents.on("composer:replace-text", this, "_replaceText");
    }

    if (isTesting()) {
      this.element.addEventListener("paste", this.paste.bind(this));
    }
  },

  _insertBlock(text) {
    this._addBlock(this._getSelected(), text);
  },

  _insertText(text, options) {
    this._addText(this._getSelected(), text, options);
  },

  @on("willDestroyElement")
  _shutDown() {
    if (this.composerEvents) {
      this.appEvents.off("composer:insert-block", this, "_insertBlock");
      this.appEvents.off("composer:insert-text", this, "_insertText");
      this.appEvents.off("composer:replace-text", this, "_replaceText");
    }

    this._mouseTrap.reset();
    $(this.element.querySelector(".d-editor-preview")).off("click.preview");

    if (isTesting()) {
      this.element.removeEventListener("paste", this.paste);
    }
  },

  @discourseComputed()
  toolbar() {
    const toolbar = new Toolbar(
      this.getProperties("site", "siteSettings", "showLink")
    );
    toolbar.context = this;

    _createCallbacks.forEach((cb) => cb(toolbar));

    if (this.extraButtons) {
      this.extraButtons(toolbar);
    }
    return toolbar;
  },

  cachedCookAsync(text) {
    if (this._cachedCookFunction) {
      return Promise.resolve(this._cachedCookFunction(text));
    }

    const markdownOptions = this.markdownOptions || {};
    return generateCookFunction(markdownOptions).then((cook) => {
      this._cachedCookFunction = cook;
      return cook(text);
    });
  },

  _updatePreview() {
    if (this._state !== "inDOM" || !this.processPreview) {
      return;
    }

    const value = this.value;

    this.cachedCookAsync(value).then((cooked) => {
      if (this.isDestroyed) {
        return;
      }

      if (this.preview === cooked) {
        return;
      }

      this.set("preview", cooked);

      if (this.siteSettings.enable_diffhtml_preview) {
        const cookedElement = document.createElement("div");
        cookedElement.innerHTML = cooked;

        linkSeenHashtags($(cookedElement));
        linkSeenMentions($(cookedElement), this.siteSettings);
        resolveCachedShortUrls(this.siteSettings, cookedElement);
        loadOneboxes(
          cookedElement,
          ajax,
          null,
          null,
          this.siteSettings.max_oneboxes_per_post,
          false,
          true
        );

        loadScript("/javascripts/diffhtml.min.js").then(() => {
          // changing the contents of the preview element between two uses of
          // diff.innerHTML did not apply the diff correctly
          window.diff.release(this.element.querySelector(".d-editor-preview"));
          window.diff.innerHTML(
            this.element.querySelector(".d-editor-preview"),
            cookedElement.innerHTML,
            {
              parser: {
                rawElements: ["script", "noscript", "style", "template"],
              },
            }
          );
        });
      }

      schedule("afterRender", () => {
        if (this._state !== "inDOM" || !this.element) {
          return;
        }

        const preview = this.element.querySelector(".d-editor-preview");
        if (!preview) {
          return;
        }

        // prevents any tab focus in preview
        preview.querySelectorAll("a").forEach((anchor) => {
          anchor.setAttribute("tabindex", "-1");
        });

        if (this.previewUpdated) {
          this.previewUpdated($(preview));
        }
      });
    });
  },

  @observes("ready", "value", "processPreview")
  _watchForChanges() {
    if (!this.ready) {
      return;
    }

    // Debouncing in test mode is complicated
    if (isTesting()) {
      this._updatePreview();
    } else {
      discourseDebounce(this, this._updatePreview, 30);
    }
  },

  _applyCategoryHashtagAutocomplete() {
    const siteSettings = this.siteSettings;

    $(this.element.querySelector(".d-editor-input")).autocomplete({
      template: findRawTemplate("category-tag-autocomplete"),
      key: "#",
      afterComplete: (value) => {
        this.set("value", value);
        return this._focusTextArea();
      },
      transformComplete: (obj) => {
        return obj.text;
      },
      dataSource: (term) => {
        if (term.match(/\s/)) {
          return null;
        }
        return searchCategoryTag(term, siteSettings);
      },
      triggerRule: (textarea, opts) => {
        return categoryHashtagTriggerRule(textarea, opts);
      },
    });
  },

  _applyEmojiAutocomplete($editorInput) {
    if (!this.siteSettings.enable_emoji) {
      return;
    }

    $editorInput.autocomplete({
      template: findRawTemplate("emoji-selector-autocomplete"),
      key: ":",
      afterComplete: (text) => {
        this.set("value", text);
        this._focusTextArea();
      },

      onKeyUp: (text, cp) => {
        if (inCodeBlock(text, cp)) {
          return false;
        }

        const matches = /(?:^|[\s.\?,@\/#!%&*;:\[\]{}=\-_()])(:(?!:).?[\w-]*:?(?!:)(?:t\d?)?:?) ?$/gi.exec(
          text.substring(0, cp)
        );

        if (matches && matches[1]) {
          return [matches[1]];
        }
      },

      transformComplete: (v) => {
        if (v.code) {
          this.emojiStore.track(v.code);
          return `${v.code}:`;
        } else {
          $editorInput.autocomplete({ cancel: true });
          this.set("emojiPickerIsActive", true);

          schedule("afterRender", () => {
            const filterInput = document.querySelector(
              ".emoji-picker input[name='filter']"
            );
            if (filterInput) {
              filterInput.value = v.term;

              later(() => filterInput.dispatchEvent(new Event("input")), 50);
            }
          });

          return "";
        }
      },

      dataSource: (term) => {
        return new Promise((resolve) => {
          const full = `:${term}`;
          term = term.toLowerCase();

          if (term.length < this.siteSettings.emoji_autocomplete_min_chars) {
            return resolve(SKIP);
          }

          if (term === "") {
            if (this.emojiStore.favorites.length) {
              return resolve(this.emojiStore.favorites.slice(0, 5));
            } else {
              return resolve([
                "slight_smile",
                "smile",
                "wink",
                "sunny",
                "blush",
              ]);
            }
          }

          // note this will only work for emojis starting with :
          // eg: :-)
          const allTranslations = Object.assign(
            {},
            translations,
            this.getWithDefault("site.custom_emoji_translation", {})
          );
          if (allTranslations[full]) {
            return resolve([allTranslations[full]]);
          }

          const match = term.match(/^:?(.*?):t([2-6])?$/);
          if (match) {
            const name = match[1];
            const scale = match[2];

            if (isSkinTonableEmoji(name)) {
              if (scale) {
                return resolve([`${name}:t${scale}`]);
              } else {
                return resolve([2, 3, 4, 5, 6].map((x) => `${name}:t${x}`));
              }
            }
          }

          const options = emojiSearch(term, {
            maxResults: 5,
            diversity: this.emojiStore.diversity,
          });

          return resolve(options);
        })
          .then((list) =>
            list.map((code) => {
              return { code, src: emojiUrlFor(code) };
            })
          )
          .then((list) => {
            if (list.length) {
              list.push({ label: I18n.t("composer.more_emoji"), term });
            }
            return list;
          });
      },

      triggerRule: (textarea) =>
        !inCodeBlock(textarea.value, caretPosition(textarea)),
    });
  },

  _getSelected(trimLeading, opts) {
    if (!this.ready || !this.element) {
      return;
    }

    const textarea = this.element.querySelector("textarea.d-editor-input");
    const value = textarea.value;
    let start = textarea.selectionStart;
    let end = textarea.selectionEnd;

    // trim trailing spaces cause **test ** would be invalid
    while (end > start && /\s/.test(value.charAt(end - 1))) {
      end--;
    }

    if (trimLeading) {
      // trim leading spaces cause ** test** would be invalid
      while (end > start && /\s/.test(value.charAt(start))) {
        start++;
      }
    }

    const selVal = value.substring(start, end);
    const pre = value.slice(0, start);
    const post = value.slice(end);

    if (opts && opts.lineVal) {
      const lineVal = value.split("\n")[
        value.substr(0, textarea.selectionStart).split("\n").length - 1
      ];
      return { start, end, value: selVal, pre, post, lineVal };
    } else {
      return { start, end, value: selVal, pre, post };
    }
  },

  _selectText(from, length, opts = { scroll: true }) {
    next(() => {
      if (!this.element) {
        return;
      }

      const textarea = this.element.querySelector("textarea.d-editor-input");
      const $textarea = $(textarea);
      textarea.selectionStart = from;
      textarea.selectionEnd = from + length;
      $textarea.trigger("change");
      if (opts.scroll) {
        const oldScrollPos = $textarea.scrollTop();
        if (!this.capabilities.isIOS || safariHacksDisabled()) {
          $textarea.focus();
        }
        $textarea.scrollTop(oldScrollPos);
      }
    });
  },

  // perform the same operation over many lines of text
  _getMultilineContents(lines, head, hval, hlen, tail, tlen, opts) {
    let operation = OP.NONE;

    const applyEmptyLines = opts && opts.applyEmptyLines;

    return lines
      .map((l) => {
        if (!applyEmptyLines && l.length === 0) {
          return l;
        }

        if (
          operation !== OP.ADDED &&
          ((l.slice(0, hlen) === hval && tlen === 0) ||
            (tail.length && l.slice(-tlen) === tail))
        ) {
          operation = OP.REMOVED;
          if (tlen === 0) {
            const result = l.slice(hlen);
            [hval, hlen] = getHead(head, hval);
            return result;
          } else if (l.slice(-tlen) === tail) {
            const result = l.slice(hlen, -tlen);
            [hval, hlen] = getHead(head, hval);
            return result;
          }
        } else if (operation === OP.NONE) {
          operation = OP.ADDED;
        } else if (operation === OP.REMOVED) {
          return l;
        }

        const result = `${hval}${l}${tail}`;
        [hval, hlen] = getHead(head, hval);
        return result;
      })
      .join("\n");
  },

  _applySurround(sel, head, tail, exampleKey, opts) {
    const pre = sel.pre;
    const post = sel.post;

    const tlen = tail.length;
    if (sel.start === sel.end) {
      if (tlen === 0) {
        return;
      }

      const [hval, hlen] = getHead(head);
      const example = I18n.t(`composer.${exampleKey}`);
      this.set("value", `${pre}${hval}${example}${tail}${post}`);
      this._selectText(pre.length + hlen, example.length);
    } else if (opts && !opts.multiline) {
      let [hval, hlen] = getHead(head);

      if (opts.useBlockMode && sel.value.split("\n").length > 1) {
        hval += "\n";
        hlen += 1;
        tail = `\n${tail}`;
      }

      if (pre.slice(-hlen) === hval && post.slice(0, tail.length) === tail) {
        this.set(
          "value",
          `${pre.slice(0, -hlen)}${sel.value}${post.slice(tail.length)}`
        );
        this._selectText(sel.start - hlen, sel.value.length);
      } else {
        this.set("value", `${pre}${hval}${sel.value}${tail}${post}`);
        this._selectText(sel.start + hlen, sel.value.length);
      }
    } else {
      const lines = sel.value.split("\n");

      let [hval, hlen] = getHead(head);
      if (
        lines.length === 1 &&
        pre.slice(-tlen) === tail &&
        post.slice(0, hlen) === hval
      ) {
        this.set(
          "value",
          `${pre.slice(0, -hlen)}${sel.value}${post.slice(tlen)}`
        );
        this._selectText(sel.start - hlen, sel.value.length);
      } else {
        const contents = this._getMultilineContents(
          lines,
          head,
          hval,
          hlen,
          tail,
          tlen,
          opts
        );

        this.set("value", `${pre}${contents}${post}`);
        if (lines.length === 1 && tlen > 0) {
          this._selectText(sel.start + hlen, sel.value.length);
        } else {
          this._selectText(sel.start, contents.length);
        }
      }
    }
  },

  _applyList(sel, head, exampleKey, opts) {
    if (sel.value.indexOf("\n") !== -1) {
      this._applySurround(sel, head, "", exampleKey, opts);
    } else {
      const [hval, hlen] = getHead(head);
      if (sel.start === sel.end) {
        sel.value = I18n.t(`composer.${exampleKey}`);
      }

      const trimmedPre = sel.pre.trim();
      const number =
        sel.value.indexOf(hval) === 0
          ? sel.value.slice(hlen)
          : `${hval}${sel.value}`;
      const preLines = trimmedPre.length ? `${trimmedPre}\n\n` : "";

      const trimmedPost = sel.post.trim();
      const post = trimmedPost.length ? `\n\n${trimmedPost}` : trimmedPost;

      this.set("value", `${preLines}${number}${post}`);
      this._selectText(preLines.length, number.length);
    }
  },

  _replaceText(oldVal, newVal, opts = {}) {
    const val = this.value;
    const needleStart = val.indexOf(oldVal);

    if (needleStart === -1) {
      // Nothing to replace.
      return;
    }

    const textarea = this.element.querySelector("textarea.d-editor-input");

    // Determine post-replace selection.
    const newSelection = determinePostReplaceSelection({
      selection: { start: textarea.selectionStart, end: textarea.selectionEnd },
      needle: { start: needleStart, end: needleStart + oldVal.length },
      replacement: { start: needleStart, end: needleStart + newVal.length },
    });

    if (opts.index && opts.regex) {
      let i = -1;
      const newValue = val.replace(opts.regex, (match) => {
        i++;
        return i === opts.index ? newVal : match;
      });
      this.set("value", newValue);
    } else {
      // Replace value (side effect: cursor at the end).
      this.set("value", val.replace(oldVal, newVal));
    }

    if (opts.forceFocus || $("textarea.d-editor-input").is(":focus")) {
      // Restore cursor.
      this._selectText(
        newSelection.start,
        newSelection.end - newSelection.start
      );
    }
  },

  _addBlock(sel, text) {
    text = (text || "").trim();
    if (text.length === 0) {
      return;
    }

    let pre = sel.pre;
    let post = sel.value + sel.post;

    if (pre.length > 0) {
      pre = pre.replace(/\n*$/, "\n\n");
    }

    if (post.length > 0) {
      post = post.replace(/^\n*/, "\n\n");
    } else {
      post = "\n";
    }

    const value = pre + text + post;
    const $textarea = $(this.element.querySelector("textarea.d-editor-input"));

    this.set("value", value);

    $textarea.val(value);
    $textarea.prop("selectionStart", (pre + text).length + 2);
    $textarea.prop("selectionEnd", (pre + text).length + 2);

    this._focusTextArea();
  },

  _addText(sel, text, options) {
    const $textarea = $(this.element.querySelector("textarea.d-editor-input"));

    if (options && options.ensureSpace) {
      if ((sel.pre + "").length > 0) {
        if (!sel.pre.match(/\s$/)) {
          text = " " + text;
        }
      }
      if ((sel.post + "").length > 0) {
        if (!sel.post.match(/^\s/)) {
          text = text + " ";
        }
      }
    }

    const insert = `${sel.pre}${text}`;
    const value = `${insert}${sel.post}`;
    this.set("value", value);
    $textarea.val(value);
    $textarea.prop("selectionStart", insert.length);
    $textarea.prop("selectionEnd", insert.length);
    next(() => $textarea.trigger("change"));
    this._focusTextArea();
  },

  _extractTable(text) {
    if (text.endsWith("\n")) {
      text = text.substring(0, text.length - 1);
    }

    text = text.split("");
    let cell = false;
    text.forEach((char, index) => {
      if (char === "\n" && cell) {
        text[index] = "\r";
      }
      if (char === '"') {
        text[index] = "";
        cell = !cell;
      }
    });

    let rows = text.join("").replace(/\r/g, "<br>").split("\n");

    if (rows.length > 1) {
      const columns = rows.map((r) => r.split("\t").length);
      const isTable =
        columns.reduce((a, b) => a && columns[0] === b && b > 1) &&
        !(columns[0] === 2 && rows[0].split("\t")[0].match(/^•$|^\d+.$/)); // to skip tab delimited lists

      if (isTable) {
        const splitterRow = [...Array(columns[0])].map(() => "---").join("\t");
        rows.splice(1, 0, splitterRow);

        return (
          "|" + rows.map((r) => r.split("\t").join("|")).join("|\n|") + "|\n"
        );
      }
    }
    return null;
  },

  _toggleDirection() {
    const $textArea = $(".d-editor-input");
    let currentDir = $textArea.attr("dir") ? $textArea.attr("dir") : siteDir(),
      newDir = currentDir === "ltr" ? "rtl" : "ltr";

    $textArea.attr("dir", newDir).focus();
  },

  paste(e) {
    if (!$(".d-editor-input").is(":focus") && !isTesting()) {
      return;
    }

    const isComposer = $("#reply-control .d-editor-input").is(":focus");
    let { clipboard, canPasteHtml, canUpload } = clipboardHelpers(e, {
      siteSettings: this.siteSettings,
      canUpload: isComposer,
    });

    let plainText = clipboard.getData("text/plain");
    let html = clipboard.getData("text/html");
    let handled = false;

    const { pre, lineVal } = this._getSelected(null, { lineVal: true });
    const isInlinePasting = pre.match(/[^\n]$/);
    const isCodeBlock = isInside(pre, /(^|\n)```/g);

    if (
      plainText &&
      this.siteSettings.enable_rich_text_paste &&
      !isInlinePasting &&
      !isCodeBlock
    ) {
      plainText = plainText.replace(/\r/g, "");
      const table = this._extractTable(plainText);
      if (table) {
        this.appEvents.trigger("composer:insert-text", table);
        handled = true;
      }
    }

    if (canPasteHtml && plainText) {
      if (isInlinePasting) {
        canPasteHtml = !(
          lineVal.match(/^```/) ||
          isInside(pre, /`/g) ||
          lineVal.match(/^    /)
        );
      } else {
        canPasteHtml = !isCodeBlock;
      }
    }

    if (canPasteHtml && !handled) {
      let markdown = toMarkdown(html);

      if (!plainText || plainText.length < markdown.length) {
        if (isInlinePasting) {
          markdown = markdown.replace(/^#+/, "").trim();
          markdown = pre.match(/\S$/) ? ` ${markdown}` : markdown;
        }

        this.appEvents.trigger("composer:insert-text", markdown);
        handled = true;
      }
    }

    if (handled || (canUpload && !plainText)) {
      e.preventDefault();
    }
  },

  // ensures textarea scroll position is correct
  _focusTextArea() {
    schedule("afterRender", () => {
      if (!this.element || this.isDestroying || this.isDestroyed) {
        return;
      }

      const textarea = this.element.querySelector("textarea.d-editor-input");
      if (!textarea) {
        return;
      }

      textarea.blur();
      textarea.focus();
    });
  },

  @action
  rovingButtonBar(event) {
    let target = event.target;
    let siblingFinder;
    if (event.code === "ArrowRight") {
      siblingFinder = "nextElementSibling";
    } else if (event.code === "ArrowLeft") {
      siblingFinder = "previousElementSibling";
    } else {
      return true;
    }

    while (
      target.parentNode &&
      !target.parentNode.classList.contains("d-editor-button-bar")
    ) {
      target = target.parentNode;
    }

    let focusable = target[siblingFinder];
    if (focusable) {
      while (
        (focusable.tagName !== "BUTTON" &&
          !focusable.classList.contains("select-kit")) ||
        focusable.classList.contains("hidden")
      ) {
        focusable = focusable[siblingFinder];
      }

      if (focusable?.tagName === "DETAILS") {
        focusable = focusable.querySelector("summary");
      }

      focusable?.focus();
    }

    return true;
  },

  actions: {
    emoji() {
      if (this.disabled) {
        return;
      }

      this.set("emojiPickerIsActive", !this.emojiPickerIsActive);
    },

    emojiSelected(code) {
      let selected = this._getSelected();
      const captures = selected.pre.match(/\B:(\w*)$/);

      if (isEmpty(captures)) {
        if (selected.pre.match(/\S$/)) {
          this._addText(selected, ` :${code}:`);
        } else {
          this._addText(selected, `:${code}:`);
        }
      } else {
        let numOfRemovedChars = selected.pre.length - captures[1].length;
        selected.pre = selected.pre.slice(
          0,
          selected.pre.length - captures[1].length
        );
        selected.start -= numOfRemovedChars;
        selected.end -= numOfRemovedChars;
        this._addText(selected, `${code}:`);
      }
    },

    toolbarButton(button) {
      if (this.disabled) {
        return;
      }

      const selected = this._getSelected(button.trimLeading);
      const toolbarEvent = {
        selected,
        selectText: (from, length) =>
          this._selectText(from, length, { scroll: false }),
        applySurround: (head, tail, exampleKey, opts) =>
          this._applySurround(selected, head, tail, exampleKey, opts),
        applyList: (head, exampleKey, opts) =>
          this._applyList(selected, head, exampleKey, opts),
        addText: (text) => this._addText(selected, text),
        replaceText: (text) => this._addText({ pre: "", post: "" }, text),
        getText: () => this.value,
        toggleDirection: () => this._toggleDirection(),
      };

      if (button.sendAction) {
        return button.sendAction(toolbarEvent);
      } else {
        button.perform(toolbarEvent);
      }
    },

    showLinkModal(toolbarEvent) {
      if (this.disabled) {
        return;
      }

      let linkText = "";
      this._lastSel = toolbarEvent.selected;

      if (this._lastSel) {
        linkText = this._lastSel.value;
      }

      showModal("insert-hyperlink").setProperties({
        linkText,
        toolbarEvent,
      });
    },

    formatCode() {
      if (this.disabled) {
        return;
      }

      const sel = this._getSelected("", { lineVal: true });
      const selValue = sel.value;
      const hasNewLine = selValue.indexOf("\n") !== -1;
      const isBlankLine = sel.lineVal.trim().length === 0;
      const isFourSpacesIndent =
        this.siteSettings.code_formatting_style === FOUR_SPACES_INDENT;

      if (!hasNewLine) {
        if (selValue.length === 0 && isBlankLine) {
          if (isFourSpacesIndent) {
            const example = I18n.t(`composer.code_text`);
            this.set("value", `${sel.pre}    ${example}${sel.post}`);
            return this._selectText(sel.pre.length + 4, example.length);
          } else {
            return this._applySurround(
              sel,
              "```\n",
              "\n```",
              "paste_code_text"
            );
          }
        } else {
          return this._applySurround(sel, "`", "`", "code_title");
        }
      } else {
        if (isFourSpacesIndent) {
          return this._applySurround(sel, "    ", "", "code_text");
        } else {
          const preNewline = sel.pre[-1] !== "\n" && sel.pre !== "" ? "\n" : "";
          const postNewline = sel.post[0] !== "\n" ? "\n" : "";
          return this._addText(
            sel,
            `${preNewline}\`\`\`\n${sel.value}\n\`\`\`${postNewline}`
          );
        }
      }
    },

    focusIn() {
      this.set("isEditorFocused", true);
    },

    focusOut() {
      this.set("isEditorFocused", false);
    },
  },
});
