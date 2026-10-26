function buildInjectionBody(db, o) {
  const caps = gmRuntime.inject ?? {};
  const lbl3 = (key, params) => fillTemplate(keyedValue("labels", key), params);
  const soul = db.list("soul", { status: "active" });
  const user = gmCapRows(db.list("user", { status: "active" }), caps.userMaxChars);
  const lines = [lbl3("inject.title"), ""];
  const injected = [];
  const pushEntries = (label, rows) => {
    if (rows.length === 0) return;
    lines.push(lbl3("inject.sectionFormat", { label }));
    for (const r of rows) {
      lines.push(`- ${r.content}`);
      injected.push(r.id);
    }
    lines.push("");
  };
  pushEntries(lbl3("inject.aboutYou"), soul);
  pushEntries(lbl3("inject.aboutUser"), user);
  const globalRules = gmCapRows(
    db.list("rules", { status: "active" }).filter((r) => isGlobalScope(r.project) && r.importance >= 2),
    caps.rulesMaxChars
  );
  pushEntries(lbl3("inject.rules"), globalRules);
  if (caps.keepProjectList !== false) {
    const projectNames = db.listProjectNames();
    if (projectNames.length > 0) {
      const max = o.titleMax;
      const shown = projectNames.map((n) => n.length > max ? n.slice(0, max) + "…" : n);
      lines.push(lbl3("inject.sectionFormat", { label: lbl3("inject.guide") }));
      lines.push(lbl3("inject.guideSearchLine"));
      lines.push(lbl3("inject.guideProjectLine"));
      lines.push(lbl3("inject.guideProjects", { list: shown.join(" / ") }));
      lines.push("");
    }
  }
  if (lines.length <= 2) return null;
  if (caps.preferLine !== false) {
    lines.push("——");
    lines.push("【记忆优先】凡涉及历史决策、偏好、配置、项目细节，或「之前是怎么做的」，回答前先用 memory_search（必要时 memory_project）查一遍记忆库，再作答；不要凭印象编。");
  }
  return { body: lines.join("\n").trimEnd(), injectedIds: injected };
}
