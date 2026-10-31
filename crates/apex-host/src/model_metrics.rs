//! Benchmark pills for the agent cards; see `apex_adapters::model_metrics`.

use apex_adapters::model_metrics::{self, ModelMetrics};

use crate::host::Host;

impl Host {
    /// Public benchmark scores for one bot's model at each reasoning level
    /// it offers. `local` is a model served from this Mac or its network.
    pub async fn model_metrics(&self, model: String, efforts: Vec<String>, current: Option<String>, local: bool) -> Result<Option<ModelMetrics>, String> {
        if !model_metrics::may_match(&model, local) {
            return Ok(None);
        }
        let cache = model_metrics::current(self.data_dir()).await;
        model_metrics::answer(&model, &efforts, current.as_deref(), local, &cache)
    }
}
