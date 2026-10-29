import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { getThemesDir } from "../src/config.ts";
import { getThemeByName } from "../src/modes/interactive/theme/theme.ts";
import { validateThemeJson } from "../src/modes/interactive/theme/theme-schema.ts";

describe("built-in themes", () => {
	it.each(["dark", "light", "abyss"])("%s validates against the schema and loads", (name) => {
		const json: unknown = JSON.parse(readFileSync(join(getThemesDir(), `${name}.json`), "utf-8"));
		expect(validateThemeJson(`${name}.json`, json).name).toBe(name);
		expect(getThemeByName(name)?.name).toBe(name);
	});
});
