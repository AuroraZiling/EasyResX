use anyhow::{Context, Result};
use quick_xml::events::Event;
use quick_xml::reader::Reader;
use quick_xml::writer::Writer;
use std::collections::HashMap;
use std::fs;
use std::io::Cursor;
use std::path::Path;

pub fn parse_resx(path: &Path) -> Result<HashMap<String, String>> {
    let mut reader = Reader::from_file(path).context("Failed to open file")?;
    reader.config_mut().trim_text(true);

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
                    let replacement = quick_xml::events::BytesText::new(new_value);
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

    let entry = format!(
        "\n    <data name=\"{}\" xml:space=\"preserve\">\n        <value>{}</value>\n    </data>",
        key, value
    );

    let new_content = if let Some(idx) = content.rfind("</root>") {
        let (start, end) = content.split_at(idx);
        format!("{}{}\n{}", start.trim_end(), entry, end)
    } else {
        // Fallback or error
        format!("{} \n<root>\n{}
</root>", content, entry) 
    };
    
    fs::write(path, new_content)?;
    Ok(())
}

pub fn remove_resx_key(path: &Path, key: &str) -> Result<()> {
    // We need to remove the whole <data> block.
    // Using the reader/writer approach again is safest to identify the block boundaries.
    let content = fs::read_to_string(path)?;
    let mut reader = Reader::from_str(&content);
    reader.config_mut().trim_text(false); 

    let mut writer = Writer::new(Cursor::new(Vec::new()));
    let mut buf = Vec::new();

    let mut inside_target_data = false;
    let mut pending_whitespace: Option<Event> = None;

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

    let result = writer.into_inner().into_inner();
    fs::write(path, result)?;

    Ok(())
}
