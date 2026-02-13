type Direction = "N" | "S" | "";

const normalizeDirection = (value?: string): Direction => {
    if (!value) return "";
    const v = value.trim().toUpperCase();
    return v === "N" || v === "S" ? v : "";
};

const LINE_DIRECTION_LABELS: Record<string, { N: string; S: string }> = {
    A: { N: "Uptown", S: "Downtown Brooklyn" },
    B: { N: "Uptown Bronx", S: "Downtown Brooklyn" },
    C: { N: "Uptown", S: "Downtown" },
    D: { N: "Uptown Bronx", S: "Downtown Brooklyn" },
    E: { N: "Uptown Queens", S: "Downtown" },
    F: { N: "Uptown Queens", S: "Downtown Brooklyn" },
    M: { N: "Queens", S: "Middle Village" },
    N: { N: "Uptown", S: "Downtown Brooklyn" },
    Q: { N: "Uptown", S: "Downtown Brooklyn" },
    R: { N: "Uptown Queens", S: "Downtown Brooklyn" },
    W: { N: "Uptown Queens", S: "Downtown Manhattan" },
};

export function resolveDirectionLabel(input: { line?: string; direction?: string; stop?: string }) {
    const line = (input.line ?? "").trim().toUpperCase();
    const direction = normalizeDirection(input.direction);

    if (line && direction && LINE_DIRECTION_LABELS[line]) {
        return LINE_DIRECTION_LABELS[line][direction];
    }
    if (input.stop && input.stop.trim().length > 0) {
        return input.stop.trim();
    }
    if (direction === "N") return "Uptown";
    if (direction === "S") return "Downtown";
    return "";
}
