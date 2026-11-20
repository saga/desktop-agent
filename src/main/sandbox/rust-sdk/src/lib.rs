#![forbid(unsafe_code)]

use std::fs;
use std::path::{Component, Path, PathBuf};

const WORKSPACE_ROOT: &str = "/workspace";
const INTERNAL_DIRECTORY: &str = ".desktop-agent";

pub struct AgentContext;

impl AgentContext {
    pub fn new() -> Self {
        Self
    }

    pub fn input_json(&self) -> Result<String, String> {
        fs::read_to_string(Path::new(WORKSPACE_ROOT).join(INTERNAL_DIRECTORY).join("input.json"))
            .map_err(|error| format!("could not read task input: {error}"))
    }

    pub fn read_text(&self, relative_path: &str) -> Result<String, String> {
        let path = resolve_workspace_path(relative_path)?;
        fs::read_to_string(path).map_err(|error| format!("could not read {relative_path}: {error}"))
    }

    pub fn write_text(&self, relative_path: &str, content: &str) -> Result<(), String> {
        let path = resolve_workspace_path(relative_path)?;
        let parent = path.parent().ok_or_else(|| "invalid destination path".to_string())?;
        fs::create_dir_all(parent).map_err(|error| format!("could not create parent directory: {error}"))?;
        fs::write(path, content).map_err(|error| format!("could not write {relative_path}: {error}"))
    }

    pub fn delete_file(&self, relative_path: &str) -> Result<(), String> {
        let path = resolve_workspace_path(relative_path)?;
        fs::remove_file(path).map_err(|error| format!("could not delete {relative_path}: {error}"))
    }

    pub fn list_files(&self, relative_directory: &str) -> Result<Vec<String>, String> {
        let root = if relative_directory.is_empty() { Path::new(WORKSPACE_ROOT).to_path_buf() } else { resolve_workspace_path(relative_directory)? };
        let mut files = Vec::new();
        collect_files(&root, Path::new(WORKSPACE_ROOT), &mut files)?;
        files.sort();
        Ok(files)
    }

    pub fn log(&self, message: &str) {
        println!("[agent] {}", message.chars().take(4000).collect::<String>());
    }

    pub fn write_result(&self, json: &str) -> Result<(), String> {
        let path = Path::new(WORKSPACE_ROOT).join(INTERNAL_DIRECTORY).join("result.json");
        fs::write(path, json).map_err(|error| format!("could not write task result: {error}"))
    }
}

impl Default for AgentContext {
    fn default() -> Self {
        Self::new()
    }
}

fn resolve_workspace_path(relative_path: &str) -> Result<PathBuf, String> {
    let candidate = Path::new(relative_path);
    if candidate.as_os_str().is_empty() || candidate.is_absolute() {
        return Err("workspace path must be a non-empty relative path".to_string());
    }
    for component in candidate.components() {
        match component {
            Component::Normal(_) => {}
            _ => return Err("workspace path contains an invalid component".to_string()),
        }
    }
    Ok(Path::new(WORKSPACE_ROOT).join(candidate))
}

fn collect_files(directory: &Path, root: &Path, output: &mut Vec<String>) -> Result<(), String> {
    let entries = fs::read_dir(directory).map_err(|error| format!("could not list directory: {error}"))?;
    for entry in entries {
        let entry = entry.map_err(|error| format!("could not read directory entry: {error}"))?;
        let file_type = entry.file_type().map_err(|error| format!("could not inspect entry: {error}"))?;
        if file_type.is_symlink() {
            continue;
        }
        let path = entry.path();
        if file_type.is_dir() && entry.file_name().to_string_lossy() == INTERNAL_DIRECTORY {
            continue;
        }
        if file_type.is_dir() {
            collect_files(&path, root, output)?;
        } else if file_type.is_file() {
            let relative = path.strip_prefix(root).map_err(|_| "path escaped workspace".to_string())?;
            output.push(relative.to_string_lossy().replace('\\', "/"));
        }
    }
    Ok(())
}
