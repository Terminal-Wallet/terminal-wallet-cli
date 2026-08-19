/**
 * Blessed renderer for a generic single-card form (src/ui/form-core.ts). Modeled
 * on runTxBuilder (tx-builder.ts): a modal with a field list + live summary +
 * footer, driven entirely through the input-provider seam and createModal. Used
 * to replace the progressive enquirer-style utility prompts (Add Token,
 * Contacts, Signer import) with one webapp-style card.
 *
 * Returns the submit result, or undefined if the user cancelled.
 */
import { getInputProvider } from "../../core/input";
import {
  FormFieldSpec,
  FormSpec,
  FormValues,
  formFieldDisplay,
  summarizeForm,
  validateForm,
} from "../form-core";
import { createModal } from "./modal";

type Row = string; // a field key, or "__submit" / "__cancel"

export const runFormCard = (
  blessed: any,
  screen: any,
  spec: FormSpec,
  initial: FormValues = {},
): Promise<{ ok: boolean; message?: string } | undefined> => {
  const provider = getInputProvider();
  const values: FormValues = { ...initial };
  const rows: Row[] = [...spec.fields.map((f) => f.key), "__submit", "__cancel"];
  const submitLabel = spec.submitLabel ?? "Save";

  return new Promise((resolve) => {
    let close: (result?: { ok: boolean; message?: string }) => void = () => undefined;
    const { box, guardFocus, close: closeChrome } = createModal(blessed, screen, {
      title: spec.title,
      widthPct: 72,
      height: rows.length + 7,
      accent: "cyan",
      onDismiss: () => close(undefined),
    });
    const list = blessed.list({
      parent: box, top: 0, left: 0, right: 0, height: rows.length, tags: true,
      keys: true, mouse: true, vi: true,
      style: { selected: { bg: "cyan", fg: "black" }, item: { fg: "white" } },
    });
    const summary = blessed.text({ parent: box, bottom: 2, left: 1, right: 1, tags: true });
    blessed.text({
      parent: box, bottom: 0, left: 1, right: 1, tags: true,
      content: "{gray-fg}↑/↓ field · Enter edit · Esc cancel{/}",
    });

    const rowLabel = (r: Row): string => {
      if (r === "__submit") return `{green-fg}▸ ${submitLabel}{/}`;
      if (r === "__cancel") return "{gray-fg}✕ Cancel{/}";
      const f = spec.fields.find((x) => x.key === r);
      if (!f) return "";
      return `${f.label.padEnd(16)}{cyan-fg}${formFieldDisplay(f, values)}{/}`;
    };

    const refresh = () => {
      list.setItems(rows.map(rowLabel));
      const v = validateForm(spec, values);
      const line = summarizeForm(spec, values);
      const errs = Object.values(v.errors);
      summary.setContent(
        v.ok ? `{green-fg}${line}{/}` : `{yellow-fg}${line}{/}  {gray-fg}(${errs[0]}){/}`,
      );
      screen.render();
    };

    const reclaim = () => {
      screen.grabKeys = true;
      list.focus();
      refresh();
    };

    close = (result?: { ok: boolean; message?: string }) => {
      closeChrome();
      resolve(result);
    };
    guardFocus(list);

    const edit = async (f: FormFieldSpec) => {
      switch (f.type) {
        case "toggle":
          values[f.key] = !values[f.key];
          break;
        case "select": {
          const choices = f.staticOptions
            ? f.staticOptions.map((o) => ({ label: o.label, value: o.value }))
            : f.options
              ? await f.options()
              : [];
          const v = await provider.select(f.label, choices);
          if (v !== undefined) values[f.key] = v;
          break;
        }
        case "password": {
          const v = await provider.input(f.label, {
            password: true,
            hint: f.hint,
            countWords: f.countWords,
          });
          if (v !== undefined) values[f.key] = v;
          break;
        }
        case "address": {
          const v = await provider.input(f.label, {
            hint: f.hint ?? (f.addressKind === "0zk" ? "RAILGUN 0zk… address" : "Ethereum 0x… address"),
          });
          if (v !== undefined) values[f.key] = v;
          break;
        }
        default: {
          // text | amount
          const v = await provider.input(f.label, f.hint ? { hint: f.hint } : undefined);
          if (v !== undefined) values[f.key] = v;
        }
      }
      reclaim();
    };

    const trySubmit = async () => {
      const v = validateForm(spec, values);
      if (!v.ok) {
        provider.notify(Object.values(v.errors)[0] ?? "Incomplete form.");
        return;
      }
      closeChrome();
      const res: { ok: boolean; error?: string; message?: string } = await spec
        .submit(values)
        .catch((e: Error) => ({ ok: false, error: e.message }));
      if (res.message) provider.notify(res.message);
      else if (!res.ok && res.error) provider.notify(res.error);
      resolve({ ok: res.ok, message: res.message });
    };

    list.on("select", (_item: any, idx: number) => {
      const r = rows[idx];
      if (r === "__submit") void trySubmit();
      else if (r === "__cancel") close();
      else {
        const field = spec.fields.find((x) => x.key === r);
        if (field) void edit(field);
      }
    });
    list.key(["escape"], () => close());

    screen.grabKeys = true;
    refresh();
    list.focus();
    screen.render();
  });
};
