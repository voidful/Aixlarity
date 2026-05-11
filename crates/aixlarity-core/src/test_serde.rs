use crate::agent::types::AgentEvent;

#[test]
fn test_serde() {
    let ev = AgentEvent::ToolCallRequested {
        turn: 1,
        call_id: "123".to_string(),
        tool_name: "test".to_string(),
        arguments: serde_json::json!({}),
    };

    let val = serde_json::to_value(&ev).unwrap();
    println!("to_value serialize: {}", serde_json::to_string(&val).unwrap());
}
