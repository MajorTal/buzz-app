use super::*;
use crate::store::tests::fixture;

fn defaults(harness: &str) -> AgentDefaults {
    AgentDefaults {
        harness: harness.into(),
        provider: "global-provider".into(),
        model: "global-model".into(),
        effort: "high".into(),
        environment: BTreeMap::from([
            ("SHARED".into(), "global".into()),
            ("GLOBAL_ONLY".into(), "global".into()),
        ]),
    }
}
fn edit(harness: &str, model: &str, effort: &str) -> AgentDefaultsEdit {
    AgentDefaultsEdit {
        harness: harness.into(),
        provider: "p".into(),
        model: model.into(),
        effort: effort.into(),
        environment: BTreeMap::new(),
    }
}

#[test]
fn blank_fields_inherit_for_the_same_harness_and_agent_values_win() {
    let mut agent = fixture();
    agent.harness.command = "buzz-agent".into();
    agent.harness.provider.clear();
    agent.harness.model.clear();
    agent.imported = Value::Null;
    agent.environment = BTreeMap::from([("SHARED".into(), "agent".into())]);
    let saved = serde_json::to_value(&agent).unwrap();
    let out = effective(&agent, &defaults("buzz-agent"));
    assert_eq!(out.harness.provider, "global-provider");
    assert_eq!(out.harness.model, "global-model");
    assert_eq!(effort(&out), Some("high"));
    // Per-key merge: the agent's key wins; other default keys are added.
    assert_eq!(out.environment["SHARED"], "agent");
    assert_eq!(out.environment["GLOBAL_ONLY"], "global");
    // A launch copy only; the saved agent is untouched.
    assert_eq!(serde_json::to_value(&agent).unwrap(), saved);

    agent.harness.model = "agent-model".into();
    agent.imported = serde_json::json!({"record":{"effort_level":"low"}});
    let out = effective(&agent, &defaults("buzz-agent"));
    assert_eq!(out.harness.model, "agent-model");
    assert_eq!(effort(&out), Some("low"));
}

#[test]
fn selectors_do_not_cross_harnesses_but_environment_does() {
    let mut agent = fixture();
    agent.harness.command = "/opt/tools/goose".into();
    agent.harness.provider.clear();
    agent.harness.model.clear();
    agent.imported = Value::Null;
    let out = effective(&agent, &defaults("buzz-agent"));
    assert_eq!(out.harness.provider, "");
    assert_eq!(out.harness.model, "");
    assert_eq!(effort(&out), None);
    assert_eq!(out.environment["GLOBAL_ONLY"], "global");
    let out = effective(&agent, &defaults("goose"));
    assert_eq!(out.harness.model, "global-model");
    agent.harness.command = "/opt/tools/buzz-pi-acp".into();
    assert_eq!(
        effective(&agent, &defaults("pi")).harness.provider,
        "global-provider"
    );
}

#[test]
fn saved_databricks_workspace_wins_over_global_environment_and_blank_inherits() {
    let mut agent = fixture();
    agent.harness.command = "buzz-agent".into();
    agent.environment.clear();
    let mut defaults = defaults("buzz-agent");
    defaults
        .environment
        .insert("DATABRICKS_HOST".into(), "https://global.example".into());
    defaults
        .environment
        .insert("DATABRICKS_MODEL_FILTER".into(), "global-*".into());
    agent.harness.databricks = Some(crate::connection::DatabricksSettings {
        host: "https://agent.example".into(),
        filter: "agent-*".into(),
    });
    let own = effective(&agent, &defaults);
    assert!(!own.environment.contains_key("DATABRICKS_HOST"));
    assert!(!own.environment.contains_key("DATABRICKS_MODEL_FILTER"));
    assert_eq!(
        own.harness.databricks.as_ref().unwrap().host,
        "https://agent.example"
    );
    assert_eq!(own.environment["GLOBAL_ONLY"], "global");
    // An explicit empty Databricks object also blocks the inherited pair.
    agent.harness.databricks = Some(Default::default());
    assert!(!effective(&agent, &defaults)
        .environment
        .contains_key("DATABRICKS_HOST"));

    agent.harness.databricks = None;
    let blank = effective(&agent, &defaults);
    assert_eq!(
        blank.environment["DATABRICKS_HOST"],
        "https://global.example"
    );
    assert_eq!(blank.environment["DATABRICKS_MODEL_FILTER"], "global-*");
    // An agent-owned environment value still wins by key when it has no
    // explicit workspace object.
    agent
        .environment
        .insert("DATABRICKS_HOST".into(), "https://env.example".into());
    let mixed = effective(&agent, &defaults);
    assert_eq!(mixed.environment["DATABRICKS_HOST"], "https://env.example");
    assert_eq!(mixed.environment["DATABRICKS_MODEL_FILTER"], "global-*");
}

#[test]
fn submitted_model_and_effort_are_explicit_across_a_harness_change() {
    let mut saved = defaults("buzz-agent");
    // The card clears both on a harness change; re-entering the same values
    // for the new harness must survive Save.
    saved.apply(edit("goose", "global-model", "high")).unwrap();
    assert_eq!(
        (saved.model.as_str(), saved.effort.as_str()),
        ("global-model", "high")
    );
    saved.apply(edit("goose", "", "")).unwrap();
    assert_eq!((saved.model.as_str(), saved.effort.as_str()), ("", ""));
    // Values chosen together with the new harness are kept.
    saved.apply(edit("pi", "pi-model", "medium")).unwrap();
    assert_eq!(
        (saved.model.as_str(), saved.effort.as_str()),
        ("pi-model", "medium")
    );
    // Same harness: nothing is cleared.
    saved.apply(edit("pi", "pi-model", "medium")).unwrap();
    assert_eq!(saved.model, "pi-model");
    assert!(saved.clone().apply(edit("claude", "", "")).is_err());
}

#[test]
fn environment_patch_is_write_only_and_validated() {
    let mut saved = defaults("buzz-agent");
    let mut patch = edit("buzz-agent", "", "");
    patch.environment = BTreeMap::from([
        ("SHARED".into(), None),
        ("API_TOKEN".into(), Some("secret-value".into())),
    ]);
    saved.apply(patch).unwrap();
    assert!(!saved.environment.contains_key("SHARED"));
    assert_eq!(saved.environment["GLOBAL_ONLY"], "global");
    let view = serde_json::to_string(&saved.view()).unwrap();
    assert!(!view.contains("secret-value") && !view.contains("\"global\""));
    assert_eq!(saved.view().environment_keys, ["API_TOKEN", "GLOBAL_ONLY"]);
    let mut reserved = edit("buzz-agent", "", "");
    reserved.environment = BTreeMap::from([("BUZZ_PRIVATE_KEY".into(), Some("x".into()))]);
    assert!(saved.apply(reserved).is_err());
}

#[test]
fn an_invalid_pi_default_pair_is_refused_before_it_is_saved() {
    // Buzz Agent defaults with a provider, then a harness-only switch to Pi:
    // the card clears model/effort but keeps the provider.
    let mut saved = defaults("buzz-agent");
    let before = saved.clone();
    let mut switch = edit("pi", "", "");
    switch.provider = "global-provider".into();
    let error = saved.apply(switch).unwrap_err();
    assert!(error.contains("Choose a Pi model"), "{error}");
    assert!(saved == before);
    // Clearing the provider, or choosing a model with it, is accepted.
    let mut cleared = edit("pi", "", "");
    cleared.provider.clear();
    saved.apply(cleared).unwrap();
    let mut chosen = edit("pi", "pi-model", "");
    chosen.provider = "global-provider".into();
    saved.apply(chosen).unwrap();
}
