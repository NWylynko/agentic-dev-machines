use crate::Cli;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs,
    io::{self, Write},
    path::PathBuf,
};

#[derive(Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Config {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub image: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub storage_class: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub model: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub lifecycle: Option<LifecycleConfig>,
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct LifecycleConfig {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub url: Option<String>,
    #[serde(default)]
    pub forward: bool,
    pub namespace: String,
    pub kubectl: String,
    pub kubeconfig: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub token_file: Option<PathBuf>,
}

fn config_home() -> Result<PathBuf> {
    let path = match std::env::var_os("XDG_CONFIG_HOME").filter(|value| !value.is_empty()) {
        Some(path) => PathBuf::from(path),
        None => home()?.join(".config"),
    };
    ensure!(
        path.is_absolute(),
        "XDG_CONFIG_HOME must be an absolute path"
    );
    Ok(path)
}

fn home() -> Result<PathBuf> {
    let path = PathBuf::from(std::env::var_os("HOME").context("HOME must be set")?);
    ensure!(path.is_absolute(), "HOME must be an absolute path");
    Ok(path)
}

fn validate_value(value: &str, field: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && !value.chars().any(char::is_whitespace),
        "{field} must be nonempty and contain no whitespace"
    );
    Ok(())
}

pub fn validate_model(model: &str) -> Result<()> {
    validate_value(model, "model")?;
    let (provider, id) = model
        .split_once('/')
        .context("model must be PROVIDER/MODEL_ID")?;
    ensure!(
        !provider.is_empty() && !id.is_empty(),
        "model must be PROVIDER/MODEL_ID"
    );
    Ok(())
}

impl Config {
    fn validate(&self) -> Result<()> {
        if let Some(image) = &self.image {
            validate_value(image, "image")?;
        }
        if let Some(storage_class) = &self.storage_class {
            validate_value(storage_class, "storageClass")?;
        }
        if let Some(model) = &self.model {
            validate_model(model)?;
        }
        Ok(())
    }
}

pub fn read_config() -> Result<Config> {
    let path = config_home()?.join("adm/config.json");
    let contents = match fs::read(&path) {
        Ok(contents) => contents,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(Config::default()),
        Err(error) => return Err(error).with_context(|| format!("read {}", path.display())),
    };
    let config: Config =
        serde_json::from_slice(&contents).with_context(|| format!("parse {}", path.display()))?;
    config
        .validate()
        .with_context(|| format!("invalid {}", path.display()))?;
    Ok(config)
}

pub fn default_image(cli: &Cli) -> Result<String> {
    let path = cli.project_dir.join("IMAGE");
    match fs::read_to_string(&path) {
        Ok(image) => {
            let image = image.trim();
            validate_value(image, "release IMAGE")?;
            Ok(image.to_owned())
        }
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            Ok("ghcr.io/nwylynko/agentic-dev-machines:latest".into())
        }
        Err(error) => Err(error).with_context(|| format!("read {}", path.display())),
    }
}

fn prompt(label: &str, default: &str) -> Result<String> {
    print!("{label} [{default}]: ");
    io::stdout().flush()?;
    let mut answer = String::new();
    ensure!(
        io::stdin().read_line(&mut answer)? != 0,
        "setup input ended; rerun adm setup in a terminal"
    );
    let answer = answer.trim();
    Ok(if answer.is_empty() { default } else { answer }.to_owned())
}

pub fn save_config(config: &Config) -> Result<PathBuf> {
    let path = config_home()?.join("adm/config.json");
    fs::create_dir_all(path.parent().expect("config parent"))?;
    let temporary = path.with_extension(format!("{}.tmp", uuid::Uuid::new_v4()));
    let mut file = fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    serde_json::to_writer_pretty(&mut file, config)?;
    writeln!(file)?;
    file.sync_all()?;
    fs::rename(&temporary, &path).with_context(|| format!("save {}", path.display()))?;
    Ok(path)
}

pub fn run(cli: &Cli) -> Result<()> {
    let mut config = read_config()?;
    println!("ADM setup. Kubernetes access and storage must already be configured.");
    let image = match &config.image {
        Some(image) => image.clone(),
        None => default_image(cli)?,
    };
    config.image = Some(prompt("Workspace image", &image)?);
    config.storage_class = Some(prompt(
        "StorageClass",
        config.storage_class.as_deref().unwrap_or("adm-replicated"),
    )?);
    let model = prompt(
        "Default model PROVIDER/MODEL_ID (optional; '-' clears)",
        config.model.as_deref().unwrap_or(""),
    )?;
    config.model = if model.is_empty() || model == "-" {
        None
    } else {
        Some(model)
    };
    config.validate()?;
    let install = prompt(
        "Install/update the cluster controller and verify client access? (yes/no)",
        "yes",
    )?;
    let connected = match install.to_ascii_lowercase().as_str() {
        "yes" | "y" => {
            let mut connection = cli.clone_for_lifecycle();
            connection.kubeconfig = Some(cli.kubeconfig_reference()?);
            let kubectl = PathBuf::from(&connection.kubectl);
            if kubectl.is_relative() && kubectl.components().count() > 1 {
                connection.kubectl = std::env::current_dir()?
                    .join(kubectl)
                    .to_string_lossy()
                    .into_owned();
            }
            if let Some(path) = &mut connection.lifecycle_token_file
                && path.is_relative()
            {
                *path = std::env::current_dir()?.join(&*path);
            }
            crate::setup_connection::preflight(&connection)?;
            crate::setup_control_plane::install(
                &connection,
                config.image.as_deref().expect("configured image"),
                config
                    .storage_class
                    .as_deref()
                    .expect("configured storage class"),
            )?;
            if !connection.lifecycle_url_explicit {
                let connected = crate::setup_connection::connect(&connection)?;
                connection.lifecycle_url = connected.url;
                connection.lifecycle_forward = true;
                connection.lifecycle_token_secret = connection.lifecycle_token_file.is_none();
                connection
                    .request_lifecycle("GET", "/v1/workspaces", None)
                    .context("verify authenticated lifecycle connection after setup")?;
            } else {
                connection.lifecycle_token_secret = connection.lifecycle_token_file.is_none();
                connection
                    .request_lifecycle("GET", "/v1/workspaces", None)
                    .context("verify authenticated lifecycle connection after setup")?;
            }
            config.lifecycle = Some(LifecycleConfig {
                url: (!connection.lifecycle_forward).then_some(connection.lifecycle_url),
                forward: connection.lifecycle_forward,
                namespace: connection.lifecycle_namespace,
                kubectl: connection.kubectl,
                kubeconfig: connection.kubeconfig.expect("selected kubeconfig"),
                token_file: connection.lifecycle_token_file,
            });
            true
        }
        "no" | "n" => false,
        _ => anyhow::bail!("answer yes or no; rerun adm setup"),
    };
    let path = save_config(&config)?;
    println!("Saved {}", path.display());
    if connected {
        println!("Lifecycle controller is installed and the authenticated connection is ready.");
    } else if config.lifecycle.is_some() {
        println!(
            "Lifecycle connection settings retained. Run `adm doctor` to check current availability."
        );
    } else {
        println!(
            "The lifecycle control plane must be installed and connected before creating workspaces."
        );
        println!("{}", crate::lifecycle::setup_guidance(cli));
    }
    println!(
        "Run `adm doctor` to check cluster and lifecycle access, then create a workspace. Use `adm login [PROVIDER]` to authenticate a provider for every workspace."
    );
    Ok(())
}

pub fn connect(cli: &Cli) -> Result<()> {
    let mut config = read_config()?;
    cli.kubeconfig_reference()?;
    let mut connection = cli.clone_for_lifecycle();
    connection.lifecycle_forward = !connection.lifecycle_url_explicit;
    connection.lifecycle_token_secret = connection.lifecycle_token_file.is_none();
    let kubeconfig = connection.kubeconfig_reference()?;
    if connection.lifecycle_forward {
        let forward = crate::setup_connection::connect(&connection)?;
        connection.lifecycle_url = forward.url.clone();
        connection
            .request_lifecycle("GET", "/v1/workspaces", None)
            .context("verify authenticated client connection")?;
        config.lifecycle = Some(LifecycleConfig {
            url: None,
            forward: true,
            namespace: connection.lifecycle_namespace,
            kubectl: connection.kubectl,
            kubeconfig,
            token_file: connection.lifecycle_token_file,
        });
        let path = save_config(&config)?;
        println!(
            "Connected to the cluster through a command-scoped lifecycle forward. Saved {}",
            path.display()
        );
    } else {
        connection
            .request_lifecycle("GET", "/v1/workspaces", None)
            .context("verify explicit lifecycle connection")?;
        config.lifecycle = Some(LifecycleConfig {
            url: Some(connection.lifecycle_url),
            forward: false,
            namespace: connection.lifecycle_namespace,
            kubectl: connection.kubectl,
            kubeconfig,
            token_file: connection.lifecycle_token_file,
        });
        let path = save_config(&config)?;
        println!(
            "Connected through the explicit lifecycle URL. Saved {}",
            path.display()
        );
    }
    Ok(())
}
