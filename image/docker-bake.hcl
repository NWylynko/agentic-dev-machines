# Builds every ADM role image from image/Dockerfile in one BuildKit run, so shared
# stages build once and the roles build in parallel. CI loads them as ROLE:ci for
# the smoke tests, then sets PUSH_REPO to push the same builds untagged, by digest;
# the promote job tags those digests only after verify passes.
# Local: docker buildx bake -f image/docker-bake.hcl

variable "PUSH_REPO" {
  default = ""
}

# "gha" in CI: each role keeps its layer cache in the Actions cache and reads all of them.
variable "CACHE" {
  default = ""
}

group "default" {
  targets = ["roles"]
}

target "roles" {
  name       = role
  matrix     = { role = ["adm-control", "adm-repositories", "adm-workspace", "adm-code", "adm-bot", "adm-dev"] }
  context    = "."
  dockerfile = "image/Dockerfile"
  target     = role
  platforms  = ["linux/amd64"]
  cache-from = CACHE == "gha" ? [for r in ["adm-control", "adm-repositories", "adm-workspace", "adm-code", "adm-bot", "adm-dev"] : "type=gha,scope=${r}"] : []
  cache-to   = CACHE == "gha" ? ["type=gha,mode=max,scope=${role}"] : []
  tags       = PUSH_REPO == "" ? ["${role}:ci"] : []
  output     = PUSH_REPO == "" ? ["type=docker"] : ["type=image,name=${PUSH_REPO}/${role},push-by-digest=true,name-canonical=true,push=true"]
}
