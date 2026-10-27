"use client";

/**
 * ChoiceSegments — three fixed choices as one radiogroup: the language and
 * the appearance in the «المزيد» sheet, and the appearance in Settings.
 *
 * THE CHOSEN ONE IS SAID WITHOUT COLOUR (c6-r4-ha-03). The current option
 * used to differ only by a slightly lighter surface and brighter text (about
 * 1.05:1 in fill and 2.3 to 2.6:1 in text), so «العربية» and «داكن» did not
 * look chosen. It now takes the same sand selection as the mode switch (owner
 * override D-3, globals.css: the sand fill, ink text and, in light, the
 * #7A5C30 edge that keeps it 3:1 on cream) plus a check mark before its
 * label, and states it as aria-checked.
 *
 * THE KEYS STAY IN THE GROUP (c6-r4-ha-02). Tab lands on the chosen option;
 * the arrows, Home and End walk the options in the writing direction and go
 * no further, so they never nudge the model behind the sheet (roving.ts).
 * The appearance follows the focus, as the mode switch does. The language
 * does not: choosing one turns the whole interface, and its direction, so it
 * waits for Space or Enter on the focused option.
 */

import { useRef, type KeyboardEvent } from "react";
import { Icon } from "../header";
import { consumeRovingKey } from "./roving";

export interface Choice<T extends string> {
  id: T;
  label: string;
}

export interface ChoiceSegmentsProps<T extends string> {
  className: "locale-segments" | "theme-segments";
  label: string;
  choices: ReadonlyArray<Choice<T>>;
  value: T;
  onChoose: (id: T) => void;
  /** True when moving the focus also chooses (the appearance). */
  followFocus: boolean;
  /** The data attribute each option carries, for the browser checks. */
  dataName?: "data-levo-theme-option" | "data-levo-locale-option";
}

export default function ChoiceSegments<T extends string>(props: ChoiceSegmentsProps<T>) {
  const refs = useRef<Array<HTMLButtonElement | null>>([]);
  const onKeyDown = (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
    const next = consumeRovingKey(event, index, props.choices.length);
    if (next < 0) return;
    if (props.followFocus) props.onChoose(props.choices[next].id);
    refs.current[next]?.focus();
  };
  return (
    <div className={props.className} role="radiogroup" aria-label={props.label}>
      {props.choices.map((choice, index) => {
        const checked = choice.id === props.value;
        const data = props.dataName ? { [props.dataName]: choice.id } : {};
        return (
          <button
            key={choice.id}
            ref={(node) => { refs.current[index] = node; }}
            type="button"
            role="radio"
            aria-checked={checked}
            tabIndex={checked ? 0 : -1}
            className={checked ? "active" : ""}
            onClick={() => props.onChoose(choice.id)}
            onKeyDown={(event) => onKeyDown(event, index)}
            {...data}
          >
            {checked && <Icon name="check" />}
            <span>{choice.label}</span>
          </button>
        );
      })}
    </div>
  );
}
