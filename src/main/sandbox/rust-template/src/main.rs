#![forbid(unsafe_code)]

use desktop_agent_sdk::AgentContext;

mod agent;

fn main() {
    let context = AgentContext::new();
    match agent::run(&context) {
        Ok(result) => {
            if let Err(error) = context.write_result(&result) {
                eprintln!("{error}");
                std::process::exit(2);
            }
        }
        Err(error) => {
            eprintln!("{error}");
            std::process::exit(1);
        }
    }
}
