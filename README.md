# Home Utility Card

[![hacs](https://img.shields.io/badge/HACS-custom-orange.svg)](https://hacs.xyz/docs/faq/custom_repositories/)
[![license](https://img.shields.io/github/license/Sandolution/ha-utility-card)](LICENSE)

Where the house's electricity comes from, what is using it, and what it costs
over the next day and a half.

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/utility-power-dark.png">
  <img alt="Live power: solar, export and import in one bar, with the biggest consumers below" src="images/utility-power-light.png" width="520">
</picture>

The card has two blocks, and draws whichever ones you configure:

- **flow**: solar kept, solar sold and grid bought as one bar, the figures
  under it, and the biggest consumers under that;
- **price**: a dynamic tariff over a rolling window, with the cheapest hour
  marked.

Live power and today's energy are the same question at two timescales (how
much of what we use is our own), so they are the same block: add the card
twice with different sensors.

There are no headings in the card. Use Home Assistant's heading card between
them.

## Installation

### HACS

1. In HACS, open the menu (⋮) → **Custom repositories**.
2. Add `https://github.com/Sandolution/ha-utility-card` with the type **Dashboard**.
3. Install **Home Utility Card**. HACS adds the dashboard resource for you.
4. Reload the browser.

### Manual

1. Download `home-utility-card.js` from this repository into `config/www/`.
2. Add it as a resource: **Settings → Dashboards → ⋮ → Resources**, URL
   `/local/home-utility-card.js`, type **JavaScript module**.
3. Reload the browser.

## Configuration

Every option can be left out. A configuration only needs the lines where it
differs from the defaults below, and at least one entity.

### Live power

```yaml
type: custom:home-utility-card
household: sensor.house_power
solar: sensor.solar_power
grid: sensor.grid_power
suffix: _power
devices: 5
decimals: 0
```

### Today's energy

```yaml
type: custom:home-utility-card
household: sensor.house_energy_daily
solar: sensor.solar_energy_daily
grid_import: sensor.grid_import_energy_daily
grid_export: sensor.grid_export_energy_daily
solar_forecast: sensor.solar_forecast_today
solar_remaining: sensor.solar_forecast_remaining
suffix: _energy_daily
devices: 3
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/utility-energy-dark.png">
  <img alt="Today's energy with the solar forecast" src="images/utility-energy-light.png" width="520">
</picture>

### Price

```yaml
type: custom:home-utility-card
price:
  entity: sensor.electricity_price
```

<picture>
  <source media="(prefers-color-scheme: dark)" srcset="images/utility-price-dark.png">
  <img alt="Dynamic electricity price over the coming hours, cheapest hour marked" src="images/utility-price-light.png" width="520">
</picture>

## Flow options

| Option | Default | |
|---|---|---|
| `household` | | What the house is using in total. |
| `solar` | | What the panels are producing. |
| `grid` | | Signed: positive is drawing from the grid, negative is feeding it. |
| `grid_import` | | Or the two directions as separate sensors, if that is how your meter publishes them. |
| `grid_export` | | The other direction. |
| `solar_forecast` | | Expected production for the whole day, shown beside the solar figure. |
| `solar_remaining` | | How much of that is still to come. Shown when you hover the solar figure. |
| `unit` | | Unit to show when the entities don't report one. |
| `decimals` | `1` | Decimals on the flow figures and the device list. |

Solar kept in the house is production minus what went back out, which is how
Home Assistant's Energy dashboard works it out too, so the two agree.

### The device list

The biggest consumers, ranked, under the flow figures.

| Option | Default | |
|---|---|---|
| `devices` | `0` | How many to list. `0` hides the list. |
| `suffix` | | The ending of the per-device entities to rank, e.g. `_power`. Needed whenever `devices` is set. |
| `exclude` | `[]` | Entity ids or names to leave out. `kitchen` leaves out `sensor.kitchen_*` but not `sensor.kitchenette_*`. |
| `floor` | `0` | Values at or below this count as idle and aren't listed. |
| `domain` | `sensor` | The domain the per-device entities are in. |
| `strip` | see below | A regular expression that takes the measurement word off the end of a device name. |
| `separator` | `" · "` | What goes between the parts of a device name. |
| `collapsible` | `false` | Adds a fold to show and hide the list. |
| `collapsed` | `true` | Whether a collapsible list starts folded. |

The `household`, `solar` and `grid` entities are left out of the ranking by
themselves; they are the house as a whole, not one of its devices.

The default `strip` is `\s*[|/-]\s*(power|energy(\s*[|/-]\s*daily)?)\s*$`, made
for names like `Kitchen | Dishwasher | Power`, which then read
`Kitchen · Dishwasher`. Set it to match how your entities are named.

## Price options

The price block is drawn when `price.entity` is set.

| Option | Default | |
|---|---|---|
| `price.entity` | | The current price, all in. |
| `price.curve` | `true` | Whether to draw the price curve. |
| `price.curve_entity` | `price.entity` | Where the curve comes from. |
| `price.curve_attribute` | detected | The attribute holding the prices. |
| `price.curve_multiply` | `1` | A number, or an entity holding one. |
| `price.curve_add` | `[]` | Numbers or entities, added to every point. |
| `price.window_back` | `3` | Hours of history on screen. |
| `price.window_ahead` | `36` | Hours ahead, as far as the entity publishes them. |
| `price.decimals` | `3` | Decimals in the price block. |
| `price.unit` | | Unit to show when the entity doesn't report one. |

The card finds the curve itself in most price integrations: it looks for a list
of points with a time (`from`, `start`, `time`, `datetime`, …) and a price
(`price`, `total`, `value`, …), and merges today's and tomorrow's lists.

`curve_multiply` and `curve_add` are there because the curve entity often only
publishes the market price, while the headline entity publishes what you
actually pay. The base is multiplied first, then the fixed parts are added. A
percentage, like VAT, has to be the multiplier; added as a fixed amount it
would flatten the curve instead of scaling it.

```yaml
price:
  entity: sensor.electricity_price_all_in
  curve_entity: sensor.electricity_market_price
  curve_multiply: 1.21        # VAT
  curve_add:
    - sensor.electricity_energy_tax
    - 0.0175                  # supplier margin
```

The window rolls instead of resetting at midnight. By the evening most of
today has passed, and that is when tomorrow's prices are the interesting part.

## text

Every string the card draws, so it can be translated or reworded. Any subset;
the rest keep their defaults. An unknown key is an error rather than being
ignored.

| Key | Default |
|---|---|
| `solar` | `Solar` |
| `remaining` | `still expected today` |
| `from_grid` | `From grid` |
| `to_grid` | `To grid` |
| `headline` | `used` |
| `from_solar` | `from solar` |
| `exported` | `exported` |
| `devices` | `Using most` |
| `show_devices` | `Show what is using most` |
| `hide_devices` | `Hide what is using most` |
| `forecast` | `Forecast:` |
| `cheapest` | `Cheapest` |
| `today` | `Today` |
| `tomorrow` | `Tomorrow` |
| `no_data` | `No readings available` |
| `no_price` | `Price sensor unavailable` |
| `no_forecast` | `No price forecast available` |

Entity and area names come from Home Assistant, so they aren't in here.

## Interaction

Every figure and every device row opens the entity behind it, by click or by
Enter and Space. The card has no timers or subscriptions of its own and only
redraws when what it shows has changed.

## Requirements

Home Assistant 2024.11 or newer.

## License

[MIT](LICENSE)
