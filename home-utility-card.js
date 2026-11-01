/*
 * home-utility-card
 *
 * A Lovelace card for household electricity, in two independent blocks:
 *
 *   flow  - solar kept, solar sold, grid bought, as one bar with the figures
 *           beneath it and the biggest consumers below that
 *   price - a dynamic tariff over a rolling window, cheapest interval marked
 *
 * A block is drawn when it is configured and left out when it is not, so the
 * same card serves live power and today's energy by being added twice with
 * different entities. Both are the same question at two timescales - how much
 * of what we are using is our own - which is why one block type covers both.
 *
 * The card renders no headings. Core's hui-heading-card does that job and
 * belongs to the dashboard: put real heading cards between instances.
 *
 * Nothing is assumed about the installation. Every entity is named in the
 * configuration, every user-visible string lives in the text block, units
 * come from the entities themselves, and per-device discovery is driven by
 * the configured suffix rather than by one household's naming convention.
 * Colours, radii and type all come from theme variables, so the card follows
 * the active theme instead of restating it.
 *
 * Configuration reference: home-utility-card.md, beside this file.
 */

const CARD_BUILD = "2026-10-09a";

const DEFAULTS = {
  /* --- flow block. Omit these and the block is not drawn. --------------- */
  household: null, // total drawn by the house
  solar: null, // produced
  grid: null, // signed: positive drawing from the grid, negative feeding it
  grid_import: null, // or give the two directions separately
  grid_export: null,
  solar_forecast: null, // optional, shown beside the solar figure
  solar_remaining: null, // optional; hover text on the solar figure

  devices: 0, // how many of the biggest consumers to list; 0 hides them
  /* The device list is the one part of this card whose height depends on the
   * configuration rather than on the house, and on a dashboard laid out in
   * sections that is the difference between a card that fits its slot and one
   * that pushes everything below it down. So it can be folded away behind a
   * chevron, leaving the figures - which are the reason for the card - always
   * visible at a fixed height.
   *
   *   collapsible  whether the fold exists at all. Off, so a dashboard
   *                written before this keeps its list where it was.
   *   collapsed    which way it starts. Folded, because somebody who asked
   *                for the fold asked for the shorter card.
   *
   * Unlike home-event-card's section folds, this one has a configured
   * starting state: there it is a reading position and belongs to whoever is
   * looking, here it is a decision about how much wall the card is worth. */
  collapsible: false,
  collapsed: true,
  suffix: null, // e.g. "_power" - the per-device entity this block ranks
  exclude: [], // entity ids or bare names; matches a whole leading segment
  decimals: 1,
  unit: null, // falls back to whatever the entities report
  floor: 0, // values at or below this are treated as idle

  /* --- price block. Omit price.entity and the block is not drawn. ------- */
  price: {
    entity: null,
    curve: true,
    curve_entity: null, // one entity; falls back to price.entity
    /* The curve entity may publish a bare market rate. These bring it onto the
     * same footing as the headline: the base is multiplied first, then the flat
     * components are added. A percentage component such as VAT has to be the
     * factor - adding it as a fixed figure would flatten the curve. */
    curve_multiply: 1, // a number, or an entity holding one
    curve_add: [], // entities (or plain numbers) summed and added per point
    curve_attribute: null, // auto-detected when unset
    window_back: 3, // hours of history kept
    window_ahead: 36, // hours forward, clipped to what the entity publishes
    decimals: 3,
    unit: null,
  },

  /* --- naming. Defaults follow Home Assistant's own conventions. -------- */
  domain: "sensor",
  strip: "\\s*[|/-]\\s*(power|energy(\\s*[|/-]\\s*daily)?)\\s*$",
  separator: " \u00b7 ",

  /* Every string the card can draw, so it can be translated without touching
   * the code. */
  text: {
    solar: "Solar",
    remaining: "still expected today",
    from_grid: "From grid",
    to_grid: "To grid",
    headline: "used",
    from_solar: "from solar",
    exported: "exported",
    devices: "Using most",
    show_devices: "Show what is using most",
    hide_devices: "Hide what is using most",
    forecast: "Forecast:",
    cheapest: "Cheapest",
    today: "Today",
    tomorrow: "Tomorrow",
    no_data: "No readings available",
    no_price: "Price sensor unavailable",
    no_forecast: "No price forecast available",
  },
};

const FLOW_KEYS = [
  "household",
  "solar",
  "grid",
  "grid_import",
  "grid_export",
  "solar_forecast",
  "solar_remaining",
];

/* ------------------------------------------------------------------ utils */

function isNum(v) {
  return typeof v === "number" && isFinite(v);
}

function stateOf(hass, id) {
  if (!hass || !id) return null;
  const st = hass.states[id];
  if (!st || st.state === "unavailable" || st.state === "unknown") return null;
  return st;
}

function numOf(hass, id) {
  const st = stateOf(hass, id);
  if (!st) return null;
  const v = Number(st.state);
  return isFinite(v) ? v : null;
}

function unitOf(hass, ids, fallback = "") {
  for (const id of Array.isArray(ids) ? ids : [ids]) {
    const st = hass && id ? hass.states[id] : null;
    const unit = st && st.attributes && st.attributes.unit_of_measurement;
    if (unit) return unit;
  }
  return fallback;
}

/* Accepts a literal number or an entity holding one, so a fixed rate and a
 * sensor-published one are configured the same way. */
function numberFrom(hass, value, fallback) {
  if (typeof value === "number") return value;
  const v = numOf(hass, value);
  return v === null ? fallback : v;
}

/* Thin-space grouping rather than a locale separator: the card mixes
 * "10 240 W" with "13.3 kWh" and a locale comma would collide with the decimal
 * point. Four digits are left alone - typographic convention leaves thousands
 * ungrouped until five, and "1 391" otherwise reads as two numbers. */
function groupInt(v) {
  const n = Math.round(Math.abs(v));
  const text = String(n);
  return n < 10000 ? text : text.replace(/\B(?=(\d{3})+(?!\d))/g, "\u202f");
}

function fixed(v, d) {
  return Number(v).toFixed(d);
}

/* Formats to the block's precision: whole numbers keep the thousands grouping,
 * anything finer gets fixed decimals. The result is markup, so the unit is
 * escaped here. */
function amount(v, decimals, unit) {
  // A reading that exists but cannot be seen: a meter offline, a sensor restarting.
  if (v === null || v === undefined) return "?";
  const text = decimals > 0 ? fixed(v, decimals) : groupInt(v);
  return unit ? `${text}\u202f${esc(unit)}` : text;
}

function pct(part, whole) {
  if (!isNum(part) || !isNum(whole) || whole <= 0) return null;
  return Math.round((part / whole) * 100);
}

function esc(s) {
  return String(s).replace(/[&<>"]/g, (c) =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c])
  );
}

function hhmm(d) {
  if (!(d instanceof Date) || isNaN(d.getTime())) return null;
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

/* Once the window runs past midnight a bare "23:00" is ambiguous, so the end
 * of the span picks up its weekday. */
function spanEnd(start, end) {
  const time = hhmm(end) || "";
  if (!(start instanceof Date) || !(end instanceof Date)) return time;
  if (start.toDateString() === end.toDateString()) return time;
  return `${weekday("short").format(end)} ${time}`;
}

/* One bar shape: solar kept, solar sold, grid bought - in that order, so the
 * two solar parts sit together and read as one production figure split by
 * where it went. Widths are normalised, so a flow at zero contributes nothing
 * and the bar is always full. */
function segments(ownSolar, toGrid, fromGrid) {
  const a = Math.max(ownSolar || 0, 0);
  const b = Math.max(toGrid || 0, 0);
  const c = Math.max(fromGrid || 0, 0);
  const total = a + b + c;
  const w = (v) => (total > 0 ? (v / total) * 100 : 0);
  return { wA: w(a), wB: w(b), wC: w(c) };
}

/* Weekday names, built once and kept.
 *
 * toLocaleDateString with options constructs a formatter internally on every
 * call, and on a wall tablet's CPU that is about a millisecond. The curve's
 * day labels and the window's end label both went through it on every
 * rebuild. */
const WEEKDAYS = new Map();

function weekday(width) {
  let f = WEEKDAYS.get(width);
  if (!f) WEEKDAYS.set(width, (f = new Intl.DateTimeFormat(undefined, { weekday: width })));
  return f;
}

/* A list option given one value - `exclude: kitchen`, `curve_add: 0.05` - is
 * how YAML reads naturally with one, so it counts as a list of one. Anything
 * other than text or numbers is refused by name rather than failing later
 * with a message about reduce. */
function listOf(value, name, what) {
  if (value == null) return [];
  const list = Array.isArray(value) ? value : [value];
  if (!list.every((v) => typeof v === "string" || typeof v === "number")) {
    throw new Error(
      `home-utility-card: ${name} is ${what}, or a list of them, not ${JSON.stringify(value)}.`
    );
  }
  return list;
}

/* Excludes may be written as an entity id or as a bare name - the ranked
 * entity and the bare stem mean the same appliance, and asking someone to know
 * which form the card wants is a needless trap. */
function toStem(value, cfg) {
  let v = String(value == null ? "" : value).trim();
  const prefix = cfg.domain + ".";
  if (v.startsWith(prefix)) v = v.slice(prefix.length);
  if (cfg.suffix && v.endsWith(cfg.suffix)) return v.slice(0, -cfg.suffix.length);
  return v;
}

/* Matches on a whole leading segment, so an entry can name one appliance
 * (kitchen_fridge) or everything in a room (server_room). The trailing
 * underscore is what keeps server_room from also swallowing server_rooms_x.
 *
 * This is a prefix on the entity id, not an area lookup - it relies on
 * entities being named consistently, and anything that breaks that convention
 * will not be caught by its room name. */
function isExcluded(stem, patterns) {
  for (const pattern of patterns) {
    if (!pattern) continue;
    if (stem === pattern || stem.startsWith(pattern + "_")) return true;
  }
  return false;
}

/* A friendly_name like "Kitchen | Dishwasher | Power" carries a domain suffix
 * that is noise once the value sits under a "Using most" label, and delimiters
 * that read better as separators. Both are configurable, since neither is a
 * Home Assistant convention. */
function deviceName(friendly, fallbackId, cfg) {
  const raw = String(friendly || fallbackId || "");
  const stripped = cfg.stripRe ? raw.replace(cfg.stripRe, "") : raw;
  const joined = cfg.separator ? stripped.replace(/\s*[|/]\s*/g, cfg.separator) : stripped;
  return joined.trim() || fallbackId;
}

/* Price curves differ per integration: some emit {time, price}, others
 * {from, till, price}. Probing for the keys instead of hard-coding them is
 * what makes price.curve_entity genuinely swappable. */
const TIME_KEYS = ["from", "from_time", "date_from", "time", "start", "datetime", "till"];
const PRICE_KEYS = ["price", "total", "value", "market_price", "all_in", "amount"];
const CURVE_ATTRS = [
  "prices",
  "tomorrow_prices",
  "upcoming_prices",
  "prices_today",
  "prices_tomorrow",
  "all_prices",
  "raw_today",
  "today",
  "data",
];

function parseCurve(list) {
  if (!Array.isArray(list) || list.length < 2) return null;
  const sample = list.find((x) => x && typeof x === "object");
  if (!sample) return null;
  const tk = TIME_KEYS.find((k) => k in sample);
  const pk = PRICE_KEYS.find((k) => k in sample && isFinite(Number(sample[k])));
  if (!tk || !pk) return null;

  const pts = [];
  for (const row of list) {
    if (!row || typeof row !== "object") continue;
    const t = new Date(row[tk]);
    const p = Number(row[pk]);
    if (isNaN(t.getTime()) || !isFinite(p)) continue;
    pts.push({ t, p });
  }
  if (pts.length < 2) return null;
  pts.sort((a, b) => a.t - b.t);
  return pts;
}

/* Every parseable list on the entity is collected, not just the first match:
 * an integration may split the window across "prices" and "tomorrow_prices",
 * and taking one and stopping would silently discard the rest. */
function collectCurve(stateObj, attrName) {
  if (!stateObj || !stateObj.attributes) return [];
  const attrs = stateObj.attributes;
  if (attrName) return parseCurve(attrs[attrName]) || [];
  let out = [];
  const seen = new Set();
  for (const k of CURVE_ATTRS.concat(Object.keys(attrs))) {
    if (seen.has(k)) continue;
    seen.add(k);
    const c = parseCurve(attrs[k]);
    if (c) out = out.concat(c);
  }
  return out;
}

/* Dedupes on the timestamp: integrations have been seen reporting each
 * interval twice, which would otherwise draw every bar at double width. */
function mergeCurves(lists) {
  const byTime = new Map();
  for (const list of lists) {
    for (const point of list || []) {
      const key = point.t.getTime();
      if (!byTime.has(key)) byTime.set(key, point);
    }
  }
  const pts = Array.from(byTime.values()).sort((a, b) => a.t - b.t);
  return pts.length >= 2 ? pts : null;
}

/* ------------------------------------------------------------------- card */

class HomeUtilityCard extends HTMLElement {
  constructor() {
    super();
    this.attachShadow({ mode: "open" });
    this._built = false;
    this._sig = null;
    this._devsOpen = undefined; // set from `collapsed` by the first setConfig
    this._devIdx = null;
    this._devIdxKey = null;
    this._onClick = (ev) => this._handleClick(ev);
    this._onKey = (ev) => this._handleKey(ev);
  }

  setConfig(config) {
    const given = config || {};
    const cfg = { ...DEFAULTS, ...given };
    cfg.price = { ...DEFAULTS.price, ...(given.price || {}) };
    cfg.price.curve_add = listOf(cfg.price.curve_add, "price.curve_add", "a number or an entity");

    /* `labels:` was this key's name before the four cards were brought onto one
     * vocabulary. Accepted silently so an existing dashboard keeps working;
     * `text:` wins if somebody has written both. */
    const text = { ...(given.labels || {}), ...(given.text || {}) };
    for (const key of Object.keys(text)) {
      if (key in DEFAULTS.text) continue;
      throw new Error(
        `home-utility-card: unknown text key "${key}". ` +
          `Valid keys: ${Object.keys(DEFAULTS.text).join(", ")}.`
      );
    }
    cfg.text = { ...DEFAULTS.text, ...text };
    delete cfg.labels;

    cfg.hasFlow = FLOW_KEYS.some((k) => cfg[k]);
    cfg.hasPrice = Boolean(cfg.price.entity);
    if (!cfg.hasFlow && !cfg.hasPrice) {
      throw new Error(
        "home-utility-card: nothing to show. Give at least one of " +
          `${FLOW_KEYS.join(", ")} or price.entity.`
      );
    }

    for (const key of ["collapsible", "collapsed"]) {
      if (typeof cfg[key] !== "boolean") {
        throw new Error(
          `home-utility-card: ${key} is true or false, not ` +
            `${JSON.stringify(cfg[key])}.`
        );
      }
    }
    /* Which way it is folded now. Read from the config here and not touched
     * by setConfig again, so a dashboard being edited does not snap the list
     * shut under somebody who has just opened it. */
    if (this._devsOpen === undefined) this._devsOpen = !cfg.collapsed;

    const n = Number(cfg.devices);
    cfg.devices = isFinite(n) && n > 0 ? Math.floor(n) : 0;
    if (cfg.devices && !cfg.suffix) {
      throw new Error(
        "home-utility-card: devices is set but suffix is not - the card needs " +
          'to know which per-device entity to rank, e.g. suffix: "_power".'
      );
    }

    if (cfg.strip) {
      try {
        cfg.stripRe = new RegExp(cfg.strip, "i");
      } catch (err) {
        throw new Error(
          `home-utility-card: strip is not a valid regular expression (${err.message})`
        );
      }
    }

    /* Entities named elsewhere in this config describe the house as a whole,
     * so they are kept out of the per-device ranking automatically - by their
     * exact id. As a prefix, household: sensor.home_power would also take
     * sensor.home_office_desk_power with it, and nothing would say why. */
    cfg.flowIds = new Set(FLOW_KEYS.map((k) => cfg[k]).filter(Boolean));
    cfg.exclude = listOf(given.exclude, "exclude", "a name or an entity id").map((v) =>
      toStem(v, cfg)
    );

    this._config = cfg;
    this._sig = null; // force a redraw on the next hass tick
    this._devIdx = null;
    /* The window, the multiply and the addends are all config, so what these
     * hold describes a card that no longer exists. */
    this._curveKey = null;
    this._winKey = null;
    this._priceKey = null;
  }

  set hass(hass) {
    this._hass = hass;
    if (!this._config) return;
    if (!this._built) this._build();
    this._render();
  }

  getCardSize() {
    return this._config && this._config.hasFlow && this._config.hasPrice ? 6 : 3;
  }

  getGridOptions() {
    return { columns: "full", rows: "auto", min_columns: 6 };
  }

  /* No disconnectedCallback: the card holds no timers and no subscriptions,
   * and its listeners live on a node inside our own shadow root, so they are
   * collected with the element. */

  _build() {
    this.shadowRoot.innerHTML = `<style>${STYLES}</style><div class="root"></div>`;
    this._root = this.shadowRoot.querySelector(".root");
    this._root.addEventListener("click", this._onClick);
    this._root.addEventListener("keydown", this._onKey);
    this._built = true;
  }

  _handleClick(ev) {
    if (this._toggled(ev)) return;
    const el = this._targetOf(ev);
    if (el) this._fireMoreInfo(el.dataset.entity);
  }

  /* The fold, which is the one thing on this card that is not a way into an
   * entity. True when it handled the event. */
  _toggled(ev) {
    const el = ev.composedPath().find((n) => n && n.dataset && n.dataset.toggle);
    if (!el) return false;
    ev.preventDefault();
    this._devsOpen = !this._devsOpen;
    this._sig = null; // the fold is a change the house did not make
    this._render();
    /* Keep the control under the finger that pressed it: it has moved, and on
     * a tablet the next tap should land on the same thing. */
    const again = this._root.querySelector("[data-toggle]");
    if (again && this.shadowRoot.activeElement) again.focus();
    return true;
  }

  /* Rows are real controls, so they answer to the keyboard as well as the
   * pointer - they carry tabindex and role="button", which would be a lie
   * without this. */
  _handleKey(ev) {
    if (ev.key !== "Enter" && ev.key !== " ") return;
    if (this._toggled(ev)) return;
    const el = this._targetOf(ev);
    if (!el) return;
    ev.preventDefault();
    this._fireMoreInfo(el.dataset.entity);
  }

  _targetOf(ev) {
    return ev.composedPath().find((n) => n && n.dataset && n.dataset.entity);
  }

  _fireMoreInfo(entityId) {
    const e = new Event("hass-more-info", { bubbles: true, composed: true });
    e.detail = { entityId };
    this.dispatchEvent(e);
  }

  /* -------------------------------------------------------------- devices */

  /* Devices are every entity carrying the configured suffix, less the excludes.
   * Anything the suffix picks up that is not an appliance belongs in `exclude`,
   * where it is visible in the config rather than inferred from a second naming
   * convention. Rebuilt only when the entity count changes, since walking every
   * state on each update would be wasteful on an always-on display. */
  /* How many entities there are, asked at most once a second.
   *
   * Object.keys materialises all 1477 of them to read .length, which measured
   * at 0.6ms on a wall tablet - so the cheap path of this cache cost
   * twice what the walk below costs, on every render of every instance. The
   * comment under it was right that walking every state per update would be
   * wasteful; the key was doing it anyway.
   *
   * Not keyed on hass.states identity, which looks stronger and is useless:
   * the frontend builds a new states object on every update, so identity
   * reads as "changed" on every tick and the cache would never hit. */
  _entityCount(hass) {
    const now = Date.now();
    if (this._ecAt !== undefined && now - this._ecAt < 1000) return this._ecN;
    this._ecAt = now;
    this._ecN = Object.keys(hass.states).length;
    return this._ecN;
  }

  _deviceIndex(hass) {
    const c = this._config;
    const key = this._entityCount(hass);
    if (this._devIdx && this._devIdxKey === key) return this._devIdx;

    const prefix = c.domain + ".";
    const list = [];
    for (const id in hass.states) {
      if (!id.startsWith(prefix) || !id.endsWith(c.suffix)) continue;
      const stem = id.slice(prefix.length, id.length - c.suffix.length);
      if (c.flowIds.has(id) || isExcluded(stem, c.exclude)) continue;
      list.push({ stem, id });
    }

    this._devIdx = list;
    this._devIdxKey = key;
    return list;
  }

  _topDevices(hass) {
    const c = this._config;
    if (!c.devices || !c.suffix) return [];
    const out = [];
    for (const d of this._deviceIndex(hass)) {
      const st = stateOf(hass, d.id);
      if (!st) continue;
      const v = Number(st.state);
      if (!isFinite(v) || v <= c.floor) continue;
      out.push({
        id: d.id,
        v,
        name: deviceName(st.attributes.friendly_name, d.id, c),
        unit: st.attributes.unit_of_measurement || c.unit || "",
      });
    }
    out.sort((a, b) => b.v - a.v);
    return out.slice(0, c.devices);
  }

  /* ---------------------------------------------------------------- model */

  _flowModel(hass, c) {
    const household = numOf(hass, c.household);
    const solar = numOf(hass, c.solar);
    let imported = numOf(hass, c.grid_import);
    let exported = numOf(hass, c.grid_export);

    // A single signed entity is the other way of expressing the same pair.
    const net = numOf(hass, c.grid);
    if (imported === null && exported === null && net !== null) {
      imported = Math.max(net, 0);
      exported = Math.max(-net, 0);
    }

    /* A meter that is configured but has no reading is unknown, not zero:
     * counted as 0, an offline grid meter drew a house running on its own
     * solar, and nothing on the card said otherwise. One that is not
     * configured at all is 0, as it always was. */
    const solarKnown = !c.solar || solar !== null;
    const importKnown = c.grid_import ? imported !== null : !c.grid || net !== null;
    const exportKnown = c.grid_export ? exported !== null : !c.grid || net !== null;

    const flow = {
      unit: unitOf(hass, [c.household, c.solar, c.grid, c.grid_import], c.unit || ""),
      household,
      solar,
      imported,
      exported,
      forecast: numOf(hass, c.solar_forecast),
      remaining: numOf(hass, c.solar_remaining),
      ok: [household, solar, imported, exported].some((v) => v !== null),
    };
    if (!flow.ok) return flow;

    const sol = Math.max(solar || 0, 0);
    const imp = Math.max(imported || 0, 0);
    const exp = Math.max(exported || 0, 0);
    // Solar that stayed in the house is production minus whatever went back
    // out; Home Assistant's Energy dashboard derives the house total the same
    // way, which is what makes the two agree.
    const own = Math.max(sol - exp, 0);

    flow.ownSolar = solarKnown && exportKnown ? own : null;
    flow.fromGrid = importKnown ? imp : null;
    flow.toGrid = exportKnown ? exp : null;
    flow.total =
      household !== null
        ? household
        : flow.ownSolar !== null && importKnown
        ? own + imp
        : null;
    /* The bar is proportions, and without every reading there are none: a
     * full solar bar with the grid unknown says "all solar" all the same. */
    const allKnown = solarKnown && importKnown && exportKnown;
    Object.assign(flow, allKnown ? segments(own, exp, imp) : segments(0, 0, 0));

    /* Drawing from the grid, the interesting share is how much came from our
     * own roof. Feeding it, it is how much of production went out. Either
     * needs every reading. */
    flow.importing = imp > 0 || sol === 0;
    flow.share = !allKnown
      ? null
      : flow.importing
      ? pct(own, own + imp)
      : pct(exp, sol);
    return flow;
  }

  _priceModel(hass, c) {
    const p = c.price;
    const priceSt = stateOf(hass, p.entity);
    const price = {
      now: priceSt ? Number(priceSt.state) : null,
      unit: unitOf(hass, p.entity, p.unit || ""),
      entity: p.entity,
      curve: null,
      cheapest: null,
    };
    if (!isFinite(price.now)) price.now = null;
    if (!p.curve) return price;

    const curveId = p.curve_entity || p.entity;
    const curveSt = hass.states[curveId];
    // Comparing the update stamp is far cheaper than serialising a few hundred
    // price points on every state change in the system.
    price.curveStamp = curveSt ? curveSt.last_updated : null;

    price.factor = numberFrom(hass, p.curve_multiply, 1);
    price.offset = p.curve_add.reduce((sum, item) => sum + numberFrom(hass, item, 0), 0);

    /* Parsed once per update of the entity that carries it.
     *
     * The stamp above was already being compared instead of serialising a few
     * hundred price points into the signature - and the saving was never
     * applied to the work the signature was guarding. Collecting 192 points,
     * re-applying the multiply and the two addends and allocating a fresh
     * object per point ran on every state change in the house, for an
     * attribute that moves once an hour. */
    const curveKey = `${price.curveStamp}|${price.factor}|${price.offset}`;
    let pts;
    if (this._curveKey === curveKey) {
      pts = this._curvePts;
    } else {
      pts = mergeCurves([collectCurve(curveSt, p.curve_attribute)]);
      if (pts && (price.factor !== 1 || price.offset !== 0)) {
        pts = pts.map((pt) => ({ t: pt.t, p: pt.p * price.factor + price.offset }));
      }
      this._curveKey = curveKey;
      this._curvePts = pts;
    }
    if (!pts) return price;

    /* A rolling window rather than a calendar day: most of today is spent by
     * the evening and the useful part is what is still coming.
     *
     * The window and the cheapest interval in it move with the clock rather
     * than with the house, so they are settled once a minute instead of
     * eleven times a second. The curve is drawn to the hour; a minute is
     * finer than anything on it. */
    const now = Date.now();
    const winKey = `${curveKey}|${Math.floor(now / 60000)}`;
    if (this._winKey === winKey) {
      price.curve = this._winCurve;
      price.cheapest = this._winCheapest;
      return price;
    }
    this._winKey = winKey;
    const from = now - (p.window_back || 0) * 3600000;
    const to = now + (p.window_ahead || 24) * 3600000;
    const win = pts.filter((x) => x.t.getTime() >= from && x.t.getTime() <= to);
    if (win.length < 2) {
      this._winCurve = null;
      this._winCheapest = null;
      return price;
    }
    price.curve = win;

    /* Cheapest is read off the curve rather than a separate sensor: it is the
     * same data, it always agrees with what is drawn, and it needs no
     * integration to publish it. Only intervals that have not finished count -
     * a cheap hour this morning is not something to act on. */
    const step = win.length > 1 ? win[1].t.getTime() - win[0].t.getTime() : 3600000;
    let best = null;
    for (let i = 0; i < win.length; i++) {
      const start = win[i].t.getTime();
      const end = i + 1 < win.length ? win[i + 1].t.getTime() : start + step;
      if (end <= now) continue;
      if (!best || win[i].p < best.value) {
        best = { value: win[i].p, index: i, from: new Date(start), till: new Date(end) };
      }
    }
    price.cheapest = best;
    this._winCurve = win;
    this._winCheapest = best;
    return price;
  }

  /* --------------------------------------------------------------- render */

  _render() {
    const hass = this._hass;
    const c = this._config;
    const flow = c.hasFlow ? this._flowModel(hass, c) : null;
    const price = c.hasPrice ? this._priceModel(hass, c) : null;
    const devices = c.hasFlow ? this._topDevices(hass) : [];

    /* hass fires on every state change in the system, which in a large install
     * is many times a second, so the DOM is only touched when what would be
     * written differs - and the markup is its own description of that.
     *
     * It used to sign the model, which was wrong in both directions. Too
     * sensitive: the model carries raw floats at source precision while every
     * one of them is painted through amount() at c.decimals, so a change too
     * small to alter a single character tore the whole subtree down, restarted
     * the chevron's transition and dropped focus out of a row. And not
     * sensitive enough: a field the card painted but the signature had not
     * listed would never have appeared at all. Comparing the string that is
     * about to be written cannot be either, and it costs less than
     * serialising the model it replaces.
     *
     * It also settles the folded appliance list for free. Folded, the ranking
     * is not in the markup, so the dryer's wattage moving while the dryer's
     * row is not on the card changes nothing - which is what used to cause
     * four fifths of this card's redraws.
     *
     * The event card still signs a model rather than its markup: its rows are
     * built from a pipeline that is the expensive part, and it has a cheaper
     * description of its own output to hand. Here the markup *is* the cheap
     * description. */
    const parts = [];
    if (flow) parts.push(this._flowCard(flow, devices));
    if (price) parts.push(this._priceCard(price));
    const html = parts.join("");
    if (html === this._sig) return;
    this._sig = html;
    this._root.innerHTML = html;
  }

  _flowCard(f, devices) {
    const c = this._config;
    const L = c.text;
    const rows = [];

    if (!f.ok) {
      return `<div class="card"><div class="empty">${esc(L.no_data)}</div></div>`;
    }

    const note =
      f.share === null ? "" : `${f.share}% ${esc(f.importing ? L.from_solar : L.exported)}`;
    rows.push(
      headline(
        amount(f.total, c.decimals, ""),
        `${esc(f.unit)} ${esc(L.headline)}`,
        note,
        c.household || c.solar
      )
    );

    rows.push(splitBar(f));

    /* "?" is a meter that has no reading; without solar configured there is
     * no meter to ask, and the figure is "-". */
    const solarValue = !c.solar
      ? "-"
      : f.forecast === null || f.solar === null
        ? amount(f.solar, c.decimals, f.unit)
        : `${amount(f.solar, c.decimals, f.unit)} ` +
          `<i class="fc">(${esc(L.forecast)} ${amount(f.forecast, c.decimals, f.unit)})</i>`;
    /* What is still to come, on hover. The figure is an aside about an aside -
     * a prediction about the rest of a prediction - so it does not get a place
     * on the face of the card. It had none for a while and nothing read it
     * either, which made `solar_remaining:` an option that did nothing.
     * Plain text rather than amount()'s markup: keyItem escapes the title. */
    const solarTip =
      f.remaining === null
        ? ""
        : `${amount(f.remaining, c.decimals, "")}${f.unit ? "\u202f" + f.unit : ""} ${L.remaining}`;

    /* The chevron rides on the key row, open or shut.
     *
     * On a row of its own it cost most of the height it was saving; moving it
     * to the eyebrow when the list opened fixed that and introduced a worse
     * problem, which is a control that is not where it was when you pressed
     * it. It stays put and turns over. */
    const foldable = devices.length > 0 && c.collapsible;
    const open = devices.length > 0 && (!c.collapsible || this._devsOpen);

    rows.push(
      `<div class="key">` +
        keyItem("seg-solar", L.solar, solarValue, c.solar, f.solar, solarTip) +
        keyItem(
          "seg-out",
          L.to_grid,
          amount(f.toGrid, c.decimals, f.unit),
          c.grid_export || c.grid,
          f.toGrid
        ) +
        keyItem(
          "seg-grid",
          L.from_grid,
          amount(f.fromGrid, c.decimals, f.unit),
          c.grid_import || c.grid,
          f.fromGrid
        ) +
        (foldable ? foldBtn(open, L) : "") +
        `</div>`
    );

    if (open) {
      rows.push(`<div class="rule"></div>`);
      rows.push(`<div class="band-lab">${esc(L.devices)}</div>`);
      rows.push(deviceList(devices, c.decimals));
    }

    return `<div class="card">${rows.join("")}</div>`;
  }

  /* The sparkline is one element per interval - about 190 of them - and this
   * card is redrawn by comparing the markup it is about to write, so building
   * this on every hass tick would cost more than the comparison saves. It
   * measured at 2.6ms a call on a wall tablet, which made it the most
   * expensive thing left on the Overview page.
   *
   * The key is the whole price model rather than a list of the fields read
   * below, so a field added to _priceModel later cannot quietly fall outside
   * it. The curve is the one part left out - a few hundred points is not
   * something to serialise either - and _winKey stands in for it, since
   * _priceModel changes that whenever it rebuilds the curve or the clock
   * moves on a minute. */
  _priceCard(p) {
    const key = `${this._winKey}|${JSON.stringify({ ...p, curve: undefined })}`;
    if (this._priceKey === key) return this._priceMarkup;
    this._priceKey = key;
    this._priceMarkup = this._buildPriceCard(p);
    return this._priceMarkup;
  }

  _buildPriceCard(p) {
    const c = this._config;
    const L = c.text;
    const d = c.price.decimals;
    const rows = [];

    let cheapest = "";
    if (p.cheapest) {
      cheapest =
        `<span class="cheap">${esc(L.cheapest)} ` +
        `${hhmm(p.cheapest.from)}\u2013${hhmm(p.cheapest.till)} \u00b7 ` +
        `${amount(p.cheapest.value, d, p.unit)}</span>`;
    }

    rows.push(
      headline(
        p.now === null ? "?" : fixed(p.now, d),
        esc(p.unit || ""),
        cheapest,
        c.price.entity
      )
    );

    if (p.curve) {
      const days = this._curveDays(p.curve, L);
      rows.push(this._curveHtml(p, days));
      const dayLabels = days
        .map((x) => `<span class="day" style="left:${x.edge.toFixed(2)}%">${esc(x.label)}</span>`)
        .join("");
      rows.push(
        `<div class="curve-foot">` +
          `<span>${esc(hhmm(p.curve[0].t) || "")}</span>` +
          dayLabels +
          `<span>${esc(spanEnd(p.curve[0].t, p.curve[p.curve.length - 1].t))}</span>` +
          `</div>`
      );
    } else {
      rows.push(`<div class="empty">${esc(p.now === null ? L.no_price : L.no_forecast)}</div>`);
    }

    return `<div class="card">${rows.join("")}</div>`;
  }

  /* Only days that begin inside the window get a label. The first day is
   * already under way - naming it made a weekday appear next to the start time
   * with nothing marking where it began. Positions are by point index rather
   * than by time, because the bars are laid out evenly by flex regardless of
   * how long each interval actually is. */
  _curveDays(pts, text) {
    const today = new Date().toDateString();
    const tomorrow = new Date(Date.now() + 86400000).toDateString();
    const days = [];
    for (let i = 1; i < pts.length; i++) {
      if (pts[i].t.toDateString() === pts[i - 1].t.toDateString()) continue;
      const d = pts[i].t;
      const key = d.toDateString();
      days.push({
        label:
          key === tomorrow
            ? text.tomorrow
            : key === today
              ? text.today
              : weekday("long").format(d),
        edge: (i / pts.length) * 100,
      });
    }
    return days;
  }

  _curveHtml(p, days) {
    const pts = p.curve;
    const values = pts.map((x) => x.p);
    const min = Math.min(...values, 0);
    const max = Math.max(...values);
    const span = max - min || 1;
    const now = Date.now();
    const step = pts.length > 1 ? pts[1].t.getTime() - pts[0].t.getTime() : 3600000;

    let nowIdx = -1;
    for (let i = 0; i < pts.length; i++) {
      if (pts[i].t.getTime() <= now) nowIdx = i;
    }

    /* Colour says what a bar is: spent, still to come, or the cheapest one
     * left. Where you are now is a line instead, so the cheapest bar keeps its
     * colour even when it happens to be the current interval. */
    const bars = pts.map((pt, i) => {
      const cls = p.cheapest && i === p.cheapest.index ? "cheap" : i > nowIdx ? "fut" : "";
      const h = Math.max(6, ((pt.p - min) / span) * 100);
      return `<i class="${cls}" style="height:${h.toFixed(1)}%"></i>`;
    });

    const marks = days
      .filter((d) => d.edge > 0)
      .map((d) => `<u class="day-sep" style="left:${d.edge.toFixed(2)}%"></u>`);

    if (nowIdx >= 0) {
      const from = pts[nowIdx].t.getTime();
      const till = nowIdx + 1 < pts.length ? pts[nowIdx + 1].t.getTime() : from + step;
      const within = Math.min(Math.max((now - from) / (till - from), 0), 1);
      const left = ((nowIdx + within) / pts.length) * 100;
      marks.push(`<u class="now-line" style="left:${left.toFixed(2)}%"></u>`);
    }

    return `<div class="curve" aria-hidden="true">${bars.join("")}${marks.join("")}</div>`;
  }

  static getStubConfig(hass) {
    const find = (suffix) =>
      Object.keys((hass && hass.states) || {}).find(
        (id) => id.startsWith("sensor.") && id.endsWith(suffix)
      ) || null;
    return {
      type: "custom:home-utility-card",
      household: find("_power"),
      solar: null,
      grid: null,
      decimals: 0,
    };
  }
}

/* ------------------------------------------------------------- fragments */

/* Big figure on the left, supporting note right-aligned above the bar. */
function headline(value, unit, note, entity) {
  return (
    `<div class="headline">` +
    `<span class="hl-main" data-entity="${esc(entity || "")}" tabindex="0" role="button">` +
    `<b>${value}</b><span>${unit}</span></span>` +
    (note ? `<span class="hl-note">${note}</span>` : "") +
    `</div>`
  );
}

/* A zero-width segment is omitted rather than drawn at 0%, so the flex gap
 * does not leave a stray sliver where a flow is inactive. */
function splitBar(m) {
  const seg = (cls, w) => (w > 0.05 ? `<i class="${cls}" style="width:${w.toFixed(1)}%"></i>` : "");
  return (
    `<div class="split">` +
    seg("seg-solar", m.wA) +
    seg("seg-out", m.wB) +
    seg("seg-grid", m.wC) +
    `</div>`
  );
}

/* The label and value are wrapped in one child rather than left as loose text
 * nodes: .key is a flex row, and bare text between elements becomes its own
 * flex item, so the gap would apply inside the phrase as well as around it. */
function keyItem(cls, label, value, entity, magnitude, tip) {
  const zero = magnitude ? "" : " is-zero";
  return (
    `<span class="ki${zero}" data-entity="${esc(entity || "")}" tabindex="0" role="button"` +
    (tip ? ` title="${esc(tip)}"` : "") + `>` +
    `<i class="${cls}"></i><span class="kt">${esc(label)} <b>${value}</b></span></span>`
  );
}

/* The chevron that shows and hides the device list. Drawn rather than an icon:
 * two borders rotated, so it needs no font and no mdi lookup, and it stays
 * crisp at any zoom. */
function foldBtn(open, L) {
  return (
    `<span class="fold" data-toggle="devices" tabindex="0" role="button" ` +
    `aria-expanded="${open}" ` +
    `title="${esc(open ? L.hide_devices : L.show_devices)}">` +
    `<svg class="chev${open ? " up" : ""}" viewBox="0 0 10 6" aria-hidden="true">` +
    `<path d="M1 1L5 5L9 1"/></svg></span>`
  );
}

function deviceList(devices, decimals) {
  const max = devices[0] ? devices[0].v : 1;
  const rows = devices.map((d) => {
    const w = max > 0 ? Math.max((d.v / max) * 100, 3) : 0;
    const value = decimals > 0 ? fixed(d.v, decimals) : groupInt(d.v);
    return (
      `<div class="dev" data-entity="${esc(d.id)}" tabindex="0" role="button">` +
      `<span class="nm">${esc(d.name)}</span>` +
      `<span class="tr"><i style="width:${w.toFixed(1)}%"></i></span>` +
      `<span class="vl">${value}<small>${esc(d.unit)}</small></span></div>`
    );
  });
  return `<div class="devs">${rows.join("")}</div>`;
}

/* ------------------------------------------------------------------ style */

const STYLES = `
/* Line height is stated rather than inherited.
 *
 * On a Lovelace view the card picks 1.6 up from the page and every row is
 * spaced by it; mounted anywhere else - the Event Manager draws a real one to
 * preview a row - it fell back to normal and the same card set differently.
 * A card whose spacing depends on what is above it in the DOM is a card that
 * looks wrong somewhere. */
:host { display: block; line-height: var(--ha-line-height-normal, 1.6); }
.root { display: flex; flex-direction: column; }

.card {
  background: var(--ha-card-background, var(--card-background-color));
  border-radius: var(--ha-card-border-radius, 16px);
  padding: 13px 14px;
  display: flex; flex-direction: column; gap: 10px;
}
.card + .card { margin-top: 8px; }

/* Labels the device list. The only type here not on a core scale step: an
   uppercase, letter-spaced eyebrow, which core has no equivalent for. */
.band-lab {
  font-size: var(--ha-font-size-xs, 11px);
  letter-spacing: 0.1em; text-transform: uppercase;
  color: var(--secondary-text-color); font-weight: var(--ha-font-weight-medium, 500);
}

/* Value left, supporting note right. Deliberately NOT tabular-nums: tabular
   figures pad every digit to the same advance width, so a narrow "1" carries a
   visible gap and "1583" reads as "1 583". Tabular only earns its keep where
   digits stack in a column, which here is the device list and nothing else. */
.headline {
  display: flex; align-items: baseline; justify-content: space-between; gap: 10px;
}
.hl-main { display: flex; align-items: baseline; gap: 7px; min-width: 0; }
.headline b {
  font-size: var(--ha-font-size-2xl, 28px);
  font-weight: var(--ha-font-weight-normal, 400);
  letter-spacing: -0.01em; line-height: 1.05;
}
.hl-main span { font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color); }
.hl-note {
  font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color);
  white-space: nowrap; flex: none; text-align: right;
}
.hl-note .cheap { color: var(--green-color, #5cb87f); }

.split { display: flex; gap: 2px; height: 8px; }
.split i { display: block; border-radius: 2px; }
.seg-solar { background: var(--orange-color, #d98b4a); }
.seg-grid { background: var(--blue-color, #5f9ede); }
/* Hatched, and in the solar colour rather than the grid colour: what leaves
   the house is solar that was not used, so the two orange segments together
   are the production figure the key reports as "Solar". */
.seg-out {
  background: repeating-linear-gradient(115deg,
    var(--orange-color, #d98b4a) 0 3px, transparent 3px 6px);
}

.key {
  display: flex; flex-wrap: wrap; gap: 6px 16px;
  font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color);
}
.key > span { display: flex; align-items: center; gap: 6px; }
.key .kt { display: inline; }
.key i { width: 7px; height: 7px; border-radius: 2px; flex: none; }
.key b { color: var(--primary-text-color); font-weight: var(--ha-font-weight-medium, 500); }
/* A flow at zero keeps its place so the three read identically whichever way
   power is moving, but recedes so the eye skips it. */
.ki.is-zero { opacity: .45; }
/* A forecast is a prediction, so it rides on the measured figure as an aside
   rather than getting equal weight. */
.key .fc {
  font-style: italic;
  font-weight: var(--ha-font-weight-normal, 400);
  color: var(--secondary-text-color);
}

.rule { height: 1px; background: var(--divider-color, rgba(255,255,255,.06)); }

/* The fold is a control, not a row: it rides at the right-hand end of the key
   line and stays there, so it costs the card no height of its own and does not
   move out from under the finger that pressed it. */
.fold {
  display: inline-flex; align-items: center; justify-content: center;
  cursor: pointer; user-select: none;
  width: 22px; height: 18px; border-radius: 8px;
  color: var(--secondary-text-color);
}
/* align-self, because .key leaves its items to stretch and a fixed-height one
   then sits at the top of the line - 3.6px above the legend it is meant to
   read with. */
.key .fold { margin-left: auto; margin-right: -4px; align-self: center; }
.fold:hover {
  background: var(--secondary-background-color, rgba(127,127,127,.10));
  color: var(--primary-text-color);
}
.fold:focus-visible { outline: 2px solid var(--primary-color); outline-offset: 1px; }
/* Two lines meeting in the middle of their own box, rather than the usual
   square-with-two-borders turned 45 degrees.
   That trick is a pixel short of honest: the borders hug two edges of the
   square, so the corner where they meet swings well below the centre while
   the free ends stay near it, and the whole V sits low in its own box. It
   reads about 2.5px under the legend beside it, the correction is a magic
   number, and the number is different for the two directions because the
   shape is not symmetric about either axis it turns around. This is: the path
   runs y=1 to y=5 in a viewBox six deep, so its ink is centred by
   construction and stays centred when it turns over. Verified by reading the
   pixels of both states against the legend. */
.chev {
  flex: none; width: 10px; height: 6px; overflow: visible;
  fill: none; stroke: currentColor; stroke-width: 1.5;
  stroke-linecap: round; stroke-linejoin: round;
  transition: transform .16s ease;
}
.chev.up { transform: rotate(180deg); }
@media (prefers-reduced-motion: reduce) { .chev { transition: none; } }

.devs { display: flex; flex-direction: column; gap: 0; }
.dev { display: flex; align-items: center; gap: 9px; font-size: var(--ha-font-size-s, 12px); }
.dev .nm {
  color: var(--primary-text-color); flex: 1 1 auto; min-width: 0;
  white-space: nowrap; overflow: hidden; text-overflow: ellipsis;
}
.dev .tr {
  flex: 0 0 52px; height: 3px; border-radius: 2px;
  background: var(--divider-color, rgba(255,255,255,.07)); overflow: hidden;
}
.dev .tr i {
  display: block; height: 100%; border-radius: 2px;
  background: var(--secondary-text-color);
}
.dev .vl {
  flex: none; width: 62px; text-align: right;
  color: var(--primary-text-color); font-variant-numeric: tabular-nums;
}
.dev .vl small {
  color: var(--secondary-text-color); font-size: var(--ha-font-size-xs, 11px);
  margin-left: 2px;
}

.curve { display: flex; align-items: flex-end; gap: 1px; height: 30px; position: relative; }
.curve i {
  flex: 1 1 auto; border-radius: 1px 1px 0 0;
  background: var(--secondary-text-color); opacity: .45;
}
.curve i.fut { opacity: .8; }
.curve i.cheap { background: var(--green-color, #5cb87f); opacity: 1; }
/* Midnight: dashed, so it reads as a boundary rather than as another bar, and
   in the text colour so it stays visible against the bars it crosses. */
.day-sep {
  position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px;
  background: repeating-linear-gradient(to bottom,
    var(--primary-text-color) 0 4px, transparent 4px 7px);
}
/* Now: solid, and positioned inside the current interval rather than at its
   edge, so it tracks across the interval. */
.now-line {
  position: absolute; top: -5px; bottom: -5px; width: 2px; margin-left: -1px;
  border-radius: 1px; background: var(--primary-text-color);
}
.curve-foot {
  display: flex; justify-content: space-between; gap: 8px; position: relative;
  font-size: var(--ha-font-size-xs, 11px); color: var(--secondary-text-color);
}
/* Sits just right of the boundary it belongs to, so the label reads as the
   name of the stretch that starts there. */
.curve-foot .day {
  position: absolute; padding-left: 4px;
  color: var(--primary-text-color); font-weight: var(--ha-font-weight-medium, 500);
}

.empty { font-size: var(--ha-font-size-s, 12px); color: var(--secondary-text-color); }

/* Press feedback. The padding is present from the start and cancelled by an
   equal negative margin on the inline axis only, so the highlight has room to
   appear without shifting a glyph and without collapsing a vertical gap. */
.dev, .ki { padding: 3px 5px; margin-inline: -5px; border-radius: 8px; }
[data-entity]:not([data-entity=""]) { cursor: pointer; }
[data-entity]:not([data-entity=""]):hover {
  background-color: color-mix(in srgb, var(--primary-text-color) 7%, transparent);
}
[data-entity]:not([data-entity=""]):active {
  background-color: color-mix(in srgb, var(--primary-text-color) 12%, transparent);
}
[data-entity]:not([data-entity=""]):focus { outline: none; }
[data-entity]:not([data-entity=""]):focus-visible {
  outline: 2px solid var(--accent-color, var(--amber-color, #d8a24e));
  outline-offset: 1px;
}
`;

if (!customElements.get("home-utility-card")) {
  customElements.define("home-utility-card", HomeUtilityCard);

  // Deliberate load marker: Home Assistant hides the "custom element doesn't
  // exist" error for two seconds while waiting for registration, so a module
  // that never ran looks identical to one that failed at runtime. No line here
  // means the module never executed.
  console.info(
    `%c home-utility-card %c loaded (build ${CARD_BUILD}) `,
    "background:#d8a24e;color:#0f0f10;font-weight:600",
    "background:#161618;color:#f0f0f1"
  );
  window.__homeUtilityCard = { build: CARD_BUILD, loadedAt: new Date().toISOString() };

  window.customCards = window.customCards || [];
  window.customCards.push({
    type: "home-utility-card",
    name: "Home Utility Card",
    description: "Solar, grid and per-device usage as one bar, plus a dynamic price curve.",
    preview: false,
  });
}
