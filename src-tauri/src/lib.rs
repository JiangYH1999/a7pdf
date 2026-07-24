#[tauri::command]
fn read_pdf_file(path: String) -> Result<Vec<u8>, String> {
    let is_pdf = std::path::Path::new(&path)
        .extension()
        .and_then(|extension| extension.to_str())
        .is_some_and(|extension| extension.eq_ignore_ascii_case("pdf"));

    if !is_pdf {
        return Err("Only PDF files can be opened.".into());
    }

    std::fs::read(path).map_err(|error| error.to_string())
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        .plugin(tauri_plugin_opener::init())
        .invoke_handler(tauri::generate_handler![read_pdf_file])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
