//! JSON envelope — success and failure shapes pinned to the extension contract.

use serde::Serialize;

use crate::truncate::Truncation;
use crate::compress::CompressionMeta;

#[derive(Debug, Serialize)]
pub struct Success {
    pub ok: bool,
    /// Display text (already truncated), workspace-relative.
    pub text: String,
    pub truncated: bool,
    #[serde(rename = "fullOutputPath", skip_serializing_if = "Option::is_none")]
    pub full_output_path: Option<String>,
    pub exit_code: i32,
    pub wall_time_seconds: f64,
    /// Full output for programmatic callers, capped at 1 MiB.
    pub structured_output: String,
    pub structured_truncated: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub truncation: Option<Truncation>,
    pub last_line_bytes: usize,
    /// Tier-1 compression metadata (requirement 5). Additive: absent when no
    /// compression pass produced a marker.
    #[serde(skip_serializing_if = "Option::is_none")]
    pub compression: Option<CompressionMeta>,
    /// Rough token count (chars / 4) of the model-visible text.
    pub token_estimate: usize,
}

#[derive(Debug, Serialize)]
pub struct Failure {
    pub ok: bool,
    pub error: ErrorBody,
}

#[derive(Debug, Serialize)]
pub struct ErrorBody {
    pub kind: String,
    pub message: String,
}

pub fn failure(kind: &str, message: impl Into<String>) -> Failure {
    Failure {
        ok: false,
        error: ErrorBody {
            kind: kind.to_string(),
            message: message.into(),
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn failure_envelope_shape_is_stable() {
        let json = serde_json::to_string(&failure("ENOENT", "no such dir")).unwrap();
        assert_eq!(json, r#"{"ok":false,"error":{"kind":"ENOENT","message":"no such dir"}}"#);
    }

    #[test]
    fn success_omits_absent_optional_fields() {
        let envelope = Success {
            ok: true,
            text: "hi".to_string(),
            truncated: false,
            full_output_path: None,
            exit_code: 0,
            wall_time_seconds: 0.1,
            structured_output: "hi".to_string(),
            structured_truncated: false,
            truncation: None,
            last_line_bytes: 2,
            compression: None,
            token_estimate: 0,
        };
        let json = serde_json::to_string(&envelope).unwrap();
        assert!(!json.contains("fullOutputPath"));
        assert!(!json.contains("truncation"));
        assert!(!json.contains("compression"));
        assert!(json.contains("\"token_estimate\":0"));
        assert!(json.starts_with(r#"{"ok":true"#));
    }
}
