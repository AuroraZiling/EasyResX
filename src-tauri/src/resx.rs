use anyhow::{Context, Result};
use quick_xml::events::{BytesText, Event};
use quick_xml::reader::Reader;
use quick_xml::writer::Writer;
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::Path;

fn minimal_escape(data: &str) -> String {
    data.replace("&", "&amp;")
        .replace("<", "&lt;")
        .replace(">", "&gt;")
}

pub fn parse_resx(path: &Path) -> Result<HashMap<String, String>> {
    let mut reader = Reader::from_file(path).context("Failed to open file")?;
    reader.config_mut().trim_text(false);

    let mut buf = Vec::new();
    let mut entries = HashMap::new();
    let mut current_key = String::new();
    let mut current_value = String::new();
    let mut in_value = false;
    let mut processing_data = false;

    loop {
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                if e.name().as_ref() == b"data" {
                    processing_data = true;
                    current_key.clear();
                    current_value.clear();
                    for attr in e.attributes() {
                        let attr = attr?;
                        if attr.key.as_ref() == b"name" {
                            current_key = attr.unescape_value()?.to_string();
                        }
                    }
                } else if e.name().as_ref() == b"value" {
                    if processing_data {
                        in_value = true;
                        current_value.clear();
                    }
                }
            }
            Ok(Event::Text(e)) => {
                if in_value {
                    current_value.push_str(&e.unescape()?);
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name().as_ref() == b"data" {
                    if !current_key.is_empty() {
                        entries.insert(current_key.clone(), current_value.clone());
                    }
                    processing_data = false;
                    current_key.clear();
                } else if e.name().as_ref() == b"value" {
                    in_value = false;
                }
            }
            Ok(Event::Eof) => break,
            Err(e) => return Err(anyhow::anyhow!("Error at position {}: {:?}", reader.buffer_position(), e)),
            _ => (),
        }
        buf.clear();
    }

    Ok(entries)
}

pub fn update_resx_key(path: &Path, key: &str, new_value: &str) -> Result<()> {
    // We read the file and write to a temporary buffer/file, modifying the specific value
    // This preserves comments and other structure usually.
    // However, quick-xml event passing is tricky to get perfect round-trip (e.g. self-closing tags vs separate).
    // For ResX, correct structure is crucial.
    
    // Strategy: Read file into memory (string), find the specific <data name="key"> block, replace value.
    // If we use XML parser for rewriting, we ensure correctness but might change formatting.
    // Given ".net resx resource manager", users might care about diffs.
    // Let's try XML rewriting. If it's too destructive, we can switch to regex/string manipulation later.
    
    let content = fs::read_to_string(path)?;
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false); // Preserve whitespace for round-trip

    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    let mut inside_target_data = false;
    let mut inside_value = false;
    let mut skip_text = false;

    loop {
        let event = reader.read_event_into(&mut buf);
        match event {
            Ok(Event::Start(ref e)) => {
                let name = e.name();
                if name.as_ref() == b"data" {
                    // Check if this is the target key
                     for attr in e.attributes() {
                        let attr = attr?;
                        if attr.key.as_ref() == b"name" && attr.unescape_value()? == key {
                            inside_target_data = true;
                            break;
                        }
                    }
                    writer.write_event(Event::Start(e.clone()))?;
                } else if name.as_ref() == b"value" && inside_target_data {
                    inside_value = true;
                    writer.write_event(Event::Start(e.clone()))?;
                    
                    // Write new value immediately
                    let escaped = minimal_escape(new_value);
                    let replacement = quick_xml::events::BytesText::from_escaped(escaped);
                    writer.write_event(Event::Text(replacement))?;
                    skip_text = true;
                } else {
                    writer.write_event(Event::Start(e.clone()))?;
                }
            }
            Ok(Event::Text(ref e)) => {
                if inside_value {
                    if !skip_text {
                         // Should not happen if we set skip_text=true immediately
                         // But if we didn't write it yet? No, we did.
                         // Just ignore original text
                    }
                } else {
                    writer.write_event(Event::Text(e.clone()))?;
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name().as_ref() == b"value" {
                     inside_value = false;
                     skip_text = false;
                } else if e.name().as_ref() == b"data" {
                    inside_target_data = false;
                }
                writer.write_event(Event::End(e.clone()))?;
            }
            Ok(Event::Eof) => break,
            Ok(e) => {
                 writer.write_event(e)?;
            }
            Err(e) => return Err(anyhow::anyhow!("XML Error: {:?}", e)),
        }
        buf.clear();
    }

    let result = writer.into_inner().into_inner();
    fs::write(path, result)?;

    Ok(())
}

pub fn update_resx_keys(path: &Path, updates: &HashMap<String, String>) -> Result<()> {
    let content = fs::read_to_string(path)?;
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false);

    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    let mut current_key = String::new();
    let mut inside_target_data = false;
    let mut inside_value = false;
    let mut skip_text = false;

    loop {
        let event = reader.read_event_into(&mut buf);
        match event {
            Ok(Event::Start(ref e)) => {
                let name = e.name();
                if name.as_ref() == b"data" {
                     let mut is_target = false;
                     for attr in e.attributes() {
                        let attr = attr?;
                        if attr.key.as_ref() == b"name" {
                            let key_val = attr.unescape_value()?;
                            if updates.contains_key(key_val.as_ref()) {
                                current_key = key_val.to_string();
                                is_target = true;
                            }
                        }
                    }
                    
                    if is_target {
                        inside_target_data = true;
                    }
                    writer.write_event(Event::Start(e.clone()))?;
                } else if name.as_ref() == b"value" && inside_target_data {
                    inside_value = true;
                    writer.write_event(Event::Start(e.clone()))?;
                    
                    if let Some(new_val) = updates.get(&current_key) {
                        let escaped = minimal_escape(new_val);
                        let replacement = quick_xml::events::BytesText::from_escaped(escaped);
                        writer.write_event(Event::Text(replacement))?;
                        skip_text = true;
                    }
                } else {
                    writer.write_event(Event::Start(e.clone()))?;
                }
            }
            Ok(Event::Text(ref e)) => {
                if inside_value && skip_text {
                     // Skip original text
                } else {
                    writer.write_event(Event::Text(e.clone()))?;
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name().as_ref() == b"value" {
                     inside_value = false;
                     skip_text = false;
                } else if e.name().as_ref() == b"data" {
                    inside_target_data = false;
                    current_key.clear();
                }
                writer.write_event(Event::End(e.clone()))?;
            }
            Ok(Event::Eof) => break,
            Ok(e) => {
                 writer.write_event(e)?;
            }
            Err(e) => return Err(anyhow::anyhow!("XML Error: {:?}", e)),
        }
        buf.clear();
    }

    let result = writer.into_inner().into_inner();
    fs::write(path, result)?;

    Ok(())
}

pub fn rename_resx_key(path: &Path, old_key: &str, new_key: &str) -> Result<()> {
    let content = fs::read_to_string(path)?;
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false);

    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    loop {
        let event = reader.read_event_into(&mut buf);
        match event {
            Ok(Event::Start(ref e)) => {
                if e.name().as_ref() == b"data" {
                    let mut elem = e.clone();
                    let mut attributes = e.attributes().collect::<Result<Vec<_>, _>>()?;
                    let mut found = false;
                    
                    for attr in &mut attributes {
                        if attr.key.as_ref() == b"name" && attr.unescape_value()? == old_key {
                            // Replace the value of the name attribute
                            // quick-xml doesn't make it super easy to modify attributes in place on the event
                            // We have to reconstruct the element or attributes
                            found = true;
                        }
                    }

                    if found {
                        // Reconstruct attributes with new name
                        elem.clear_attributes();
                        for attr in attributes {
                            if attr.key.as_ref() == b"name" {
                                elem.push_attribute(("name", new_key));
                            } else {
                                elem.push_attribute(attr);
                            }
                        }
                    }
                    writer.write_event(Event::Start(elem))?;
                } else {
                    writer.write_event(Event::Start(e.clone()))?;
                }
            }
            Ok(Event::Eof) => break,
            Ok(e) => {
                 writer.write_event(e)?;
            }
            Err(e) => return Err(anyhow::anyhow!("XML Error: {:?}", e)),
        }
        buf.clear();
    }

    let result = writer.into_inner().into_inner();
    fs::write(path, result)?;

    Ok(())
}

pub fn add_resx_key(path: &Path, key: &str, value: &str) -> Result<()> {
    // Simple append approach: read, find </root>, insert before it.
    // This is robust enough for valid XML.
    let content = fs::read_to_string(path)?;
    // Check if key exists first
    if content.contains(&format!("name=\"{}\"", key)) {
         return Err(anyhow::anyhow!("Key already exists"));
    }

    let escaped_value = minimal_escape(value);
    let entry = format!(
        "\n    <data name=\"{}\" xml:space=\"preserve\">\n        <value>{}\"</value>\n    </data>",
        key, escaped_value
    );

    let new_content = if let Some(idx) = content.rfind("</root>") {
        let (start, end) = content.split_at(idx);
        format!("{}{}\n{}", start.trim_end(), entry, end)
    } else {
        // Fallback or error
        format!("{} \n<root>\n{}\\n</root>", content, entry) 
    };
    
    fs::write(path, new_content)?;
    Ok(())
}

pub fn remove_resx_keys(path: &Path, keys: &std::collections::HashSet<String>) -> Result<HashMap<String, usize>> {
    let content = fs::read_to_string(path)?;
    let has_bom = content.starts_with('\u{feff}');
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false); 

    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    let mut inside_target_data = false;
    let mut pending_whitespace: Option<Event> = None;
    
    let mut current_index = 0;
    let mut removed_indices = HashMap::new();
    let mut current_key = String::new();

    loop {
        let event = reader.read_event_into(&mut buf);
        match event {
            Ok(Event::Start(ref e)) => {
                let mut is_target = false;
                if e.name().as_ref() == b"data" {
                     for attr in e.attributes() {
                        let attr = attr?;
                        if attr.key.as_ref() == b"name" {
                            let key = attr.unescape_value()?;
                            if keys.contains(key.as_ref()) {
                                is_target = true;
                                current_key = key.to_string();
                            }
                        }
                    }
                    
                    if is_target {
                        removed_indices.insert(current_key.clone(), current_index);
                    }
                    current_index += 1;
                }

                if is_target {
                    inside_target_data = true;
                    // Discard pending whitespace
                    pending_whitespace = None;
                } else {
                    if !inside_target_data {
                        if let Some(ws) = pending_whitespace.take() {
                            writer.write_event(ws)?;
                        }
                        writer.write_event(Event::Start(e.clone()))?;
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if inside_target_data {
                    if e.name().as_ref() == b"data" {
                        inside_target_data = false;
                    }
                } else {
                    if let Some(ws) = pending_whitespace.take() {
                        writer.write_event(ws)?;
                    }
                    writer.write_event(Event::End(e.clone()))?;
                }
            }
            Ok(Event::Text(ref e)) => {
                 if inside_target_data {
                    // Skip text inside target
                 } else {
                    let text = e.unescape()?;
                    if text.trim().is_empty() {
                        pending_whitespace = Some(Event::Text(e.clone().into_owned()));
                    } else {
                        if let Some(ws) = pending_whitespace.take() {
                            writer.write_event(ws)?;
                        }
                        writer.write_event(Event::Text(e.clone()))?;
                    }
                }
            }
            Ok(Event::Eof) => {
                if let Some(ws) = pending_whitespace.take() {
                    writer.write_event(ws)?;
                }
                break;
            },
            Ok(e) => {
                 if !inside_target_data {
                    if let Some(ws) = pending_whitespace.take() {
                        writer.write_event(ws)?;
                    }
                    writer.write_event(e)?;
                }
            }
            Err(e) => return Err(anyhow::anyhow!("XML Error: {:?}", e)),
        }
        buf.clear();
    }

    let mut result = writer.into_inner().into_inner();
    
    if has_bom && !result.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let mut new_result = vec![0xEF, 0xBB, 0xBF];
        new_result.extend_from_slice(&result);
        result = new_result;
    }

    fs::write(path, result)?;

    Ok(removed_indices)
}

pub fn remove_resx_key(path: &Path, key: &str) -> Result<usize> {
    // We need to remove the whole <data> block.
    // Using the reader/writer approach again is safest to identify the block boundaries.
    let content = fs::read_to_string(path)?;
    let has_bom = content.starts_with('\u{feff}');
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false); 

    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    let mut inside_target_data = false;
    let mut pending_whitespace: Option<Event> = None;
    
    let mut current_index = 0;
    let mut removed_index = 0;

    loop {
        let event = reader.read_event_into(&mut buf);
        match event {
            Ok(Event::Start(ref e)) => {
                let mut is_target = false;
                if e.name().as_ref() == b"data" {
                     for attr in e.attributes() {
                        let attr = attr?;
                        if attr.key.as_ref() == b"name" && attr.unescape_value()? == key {
                            is_target = true;
                            break;
                        }
                    }
                    
                    if is_target {
                        removed_index = current_index;
                    }
                    current_index += 1;
                }

                if is_target {
                    inside_target_data = true;
                    // Discard pending whitespace (indentation before the element)
                    pending_whitespace = None;
                } else {
                    if !inside_target_data {
                        if let Some(ws) = pending_whitespace.take() {
                            writer.write_event(ws)?;
                        }
                        writer.write_event(Event::Start(e.clone()))?;
                    }
                }
            }
            Ok(Event::End(ref e)) => {
                if inside_target_data {
                    if e.name().as_ref() == b"data" {
                        inside_target_data = false;
                    }
                } else {
                    if let Some(ws) = pending_whitespace.take() {
                        writer.write_event(ws)?;
                    }
                    writer.write_event(Event::End(e.clone()))?;
                }
            }
            Ok(Event::Text(ref e)) => {
                 if inside_target_data {
                    // Skip text inside target
                 } else {
                    let text = e.unescape()?;
                    if text.trim().is_empty() {
                        // Buffer whitespace
                        // We need to own the event to store it
                        pending_whitespace = Some(Event::Text(e.clone().into_owned()));
                    } else {
                        if let Some(ws) = pending_whitespace.take() {
                            writer.write_event(ws)?;
                        }
                        writer.write_event(Event::Text(e.clone()))?;
                    }
                }
            }
            Ok(Event::Eof) => {
                if let Some(ws) = pending_whitespace.take() {
                    writer.write_event(ws)?;
                }
                break;
            },
            Ok(e) => {
                 if !inside_target_data {
                    if let Some(ws) = pending_whitespace.take() {
                        writer.write_event(ws)?;
                    }
                    writer.write_event(e)?;
                }
            }
            Err(e) => return Err(anyhow::anyhow!("XML Error: {:?}", e)),
        }
        buf.clear();
    }

    let mut result = writer.into_inner().into_inner();
    
    // Restore BOM if it was present and lost
    if has_bom && !result.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let mut new_result = vec![0xEF, 0xBB, 0xBF];
        new_result.extend_from_slice(&result);
        result = new_result;
    }

    fs::write(path, result)?;

    Ok(removed_index)
}

pub fn insert_resx_key(path: &Path, key: &str, value: &str, index: usize) -> Result<()> {
    let content = fs::read_to_string(path)?;
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false);
    let mut buf = Vec::new();
    let mut count = 0;
    let mut insert_pos = None;
    
    // Find position
    loop {
        let pos = reader.buffer_position();
        match reader.read_event_into(&mut buf) {
            Ok(Event::Start(ref e)) => {
                if e.name().as_ref() == b"data" {
                    if count == index {
                        insert_pos = Some(pos);
                        break;
                    }
                    count += 1;
                }
            }
            Ok(Event::Eof) => break,
            Err(_) => break,
            _ => {}
        }
        buf.clear();
    }
    
    let (start, end) = if let Some(pos) = insert_pos {
        content.split_at(pos as usize)
    } else {
        // Append at end (before </root>)
        if let Some(idx) = content.rfind("</root>") {
            content.split_at(idx)
        } else {
             (content.as_str(), "")
        }
    };

    let indent_from_start = if let Some(last_nl) = start.rfind('\n') {
        &start[last_nl + 1..]
    } else {
        ""
    };

    let indent_from_end = {
        let len = end.find(|c: char| !c.is_whitespace() || c == '\n' || c == '\r').unwrap_or(end.len());
        &end[..len]
    };
    
    let (target_indent, prepend, append) = if !indent_from_start.is_empty() {
        (indent_from_start, false, true)
    } else if !indent_from_end.is_empty() {
        (indent_from_end, true, false)
    } else {
        // Fallback: try to find indentation from other data elements or resheader
        let fallback_indent = if let Some(_idx) = content.find("\n    <data") {
         "    "
    } else if let Some(_idx) = content.find("\n  <data") {
         "  "
    } else if let Some(_idx) = content.find("\n\t<data") {
         "\t"
    } else if let Some(_idx) = content.find("\n    <resheader") {
         "    "
    } else if let Some(_idx) = content.find("\n  <resheader") {
         "  "
    } else {
         "    " // Default to 4 spaces
    };
        (fallback_indent, true, true)
    };

    let line_ending = if content.contains("\r\n") { "\r\n" } else { "\n" };
    let escaped_value = minimal_escape(value);
    
    let entry = format!(
        "{0}<data name=\"{1}\" xml:space=\"preserve\">{2}{3}    <value>{4}</value>{2}{3}</data>{2}{5}",
        if prepend { target_indent } else { "" },
        key, 
        line_ending, target_indent,
        escaped_value,
        if append { target_indent } else { "" }
    );

    let new_content = format!("{}{}{}", start, entry, end);
    
    fs::write(path, new_content)?;
    Ok(())
}

pub struct ResxInsert {
    pub key: String,
    pub value: String,
    pub index: usize,
}

pub fn insert_resx_keys(path: &Path, items: Vec<ResxInsert>) -> Result<()> {
    // Sort items by index to insert efficiently during stream
    let mut items = items;
    items.sort_by_key(|i| i.index);
    
    let content = fs::read_to_string(path)?;
    let has_bom = content.starts_with('\u{feff}');
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false);
    
    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();
    
    // We track how many data items we have WRITTEN to the output.
    let mut output_count = 0;
    let mut item_iter = items.into_iter().peekable();
    
    let line_ending = if content.contains("\r\n") { "\r\n" } else { "\n" };
    // Try to detect indentation from first data element
    let indent = if let Some(_idx) = content.find("\n    <data") {
         "    "
    } else if let Some(_idx) = content.find("\n  <data") {
         "  "
    } else {
         "    "
    };

    loop {
        let event = reader.read_event_into(&mut buf);
        match event {
            Ok(Event::Start(ref e)) => {
                let name = e.name();
                if name.as_ref() == b"data" {
                    // We are about to write an existing data element.
                    // Before we do, check if any new items need to be inserted here.
                    
                    while let Some(item) = item_iter.peek() {
                        if item.index <= output_count {
                             let item = item_iter.next().unwrap();
                             let escaped_value = minimal_escape(&item.value);
                             
                             // Strategy for INSERT (between items):
                             // We assume we are currently at an indented position (supplied by previous Text event).
                             // We write the element starting immediately.
                             // We finish by writing the newline and indent that the NEXT element (or this one) needs.
                             
                             let entry = format!(
                                "<data name=\"{0}\" xml:space=\"preserve\">{1}{2}{2}<value>{3}</value>{1}{2}</data>{1}{2}",
                                item.key, line_ending, indent, escaped_value
                             );
                             
                             let raw_event = Event::Text(BytesText::from_escaped(entry));
                             writer.write_event(raw_event)?;
                             output_count += 1;
                        } else {
                            break;
                        }
                    }
                    
                    writer.write_event(Event::Start(e.clone()))?;
                    output_count += 1;
                } else {
                    writer.write_event(Event::Start(e.clone()))?;
                }
            }
            Ok(Event::End(ref e)) => {
                if e.name().as_ref() == b"root" {
                     // End of root. Write any remaining items (append).
                     while let Some(item) = item_iter.next() {
                         let escaped_value = minimal_escape(&item.value);
                         
                         // Strategy for APPEND (at end):
                         // We are likely at column 0 or after a newline. 
                         // We need to provide our own leading indent.
                         // We do NOT provide a trailing indent for the next item if we are last, 
                         // but for consistency in loop, we can? 
                         // No, usually </root> follows. </root> might need indentation?
                         // If we assume we are at col 0, we write {indent}<data...>{le}.
                         
                         let entry = format!(
                            "{2}<data name=\"{0}\" xml:space=\"preserve\">{1}{2}{2}<value>{3}</value>{1}{2}</data>{1}",
                            item.key, line_ending, indent, escaped_value
                         );
                         let raw_event = Event::Text(BytesText::from_escaped(entry));
                         writer.write_event(raw_event)?;
                         output_count += 1;
                     }
                }
                writer.write_event(Event::End(e.clone()))?;
            }
             Ok(Event::Eof) => break,
             Ok(e) => {
                 writer.write_event(e)?;
             }
             Err(e) => return Err(anyhow::anyhow!("XML Error: {:?}", e)),
        }
        buf.clear();
    }
    
    let mut result = writer.into_inner().into_inner();
     if has_bom && !result.starts_with(&[0xEF, 0xBB, 0xBF]) {
        let mut new_result = vec![0xEF, 0xBB, 0xBF];
        new_result.extend_from_slice(&result);
        result = new_result;
    }
    
    fs::write(path, result)?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::fs::File;
    use std::io::Write;
    use tempfile::tempdir;

    #[test]
    fn test_remove_and_restore_key() -> Result<()> {
        let dir = tempdir()?;
        let file_path = dir.path().join("test.resx");
        
        let initial_content = r###"<?xml version="1.0" encoding="utf-8"?>
<root>
  <data name="Key1" xml:space="preserve">
    <value>Value1</value>
  </data>
  <data name="Key2" xml:space="preserve">
    <value>Value2</value>
  </data>
</root>"###;
        
        let mut file = File::create(&file_path)?;
        write!(file, "{}", initial_content)?;
        
        // Remove Key2
        let idx = remove_resx_key(&file_path, "Key2")?;
        assert_eq!(idx, 1);
        
        let content_after_remove = fs::read_to_string(&file_path)?;
        println!("Content after remove:\n{}", content_after_remove);
        // Expect indentation to be removed properly
        
        // Restore Key2
        insert_resx_key(&file_path, "Key2", "Value2", idx)?;
        
        let content_after_restore = fs::read_to_string(&file_path)?;
        println!("Content after restore:\n{}", content_after_restore);

        assert!(content_after_restore.contains("\n  <data name=\"Key2\""));
        assert!(content_after_restore.contains("    <value>Value2</value>"));

        Ok(())
    }

     #[test]
    fn test_remove_and_restore_single_key() -> Result<()> {
        let dir = tempdir()?;
        let file_path = dir.path().join("test_single.resx");
        
        // Using 4 spaces to match default fallback
        let initial_content = r###"<?xml version="1.0" encoding="utf-8"?>
<root>
    <data name="Key1" xml:space="preserve">
        <value>Value1</value>
    </data>
</root>"###;
        
        let mut file = File::create(&file_path)?;
        write!(file, "{}", initial_content)?;
        
        // Remove Key1
        let idx = remove_resx_key(&file_path, "Key1")?;
        assert_eq!(idx, 0);
        
        let content_after_remove = fs::read_to_string(&file_path)?;
        println!("Content after remove:\n{}", content_after_remove);
        
        // Restore Key1
        insert_resx_key(&file_path, "Key1", "Value1", idx)?;
        
        let content_after_restore = fs::read_to_string(&file_path)?;
        println!("Content after restore:\n{}", content_after_restore);

        // Check indentation (4 spaces)
        assert!(content_after_restore.contains("\n    <data name=\"Key1\""));
        
        Ok(())
    }
}