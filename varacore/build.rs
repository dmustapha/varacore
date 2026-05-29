// File: varacore/build.rs
// IDL generation via sails-idl-gen requires the program type as a build-dep,
// which is not possible from the crate being built. IDL is generated post-build
// using: cargo run --bin generate-idl (or gcli after deployment).
// build.rs only handles WASM binary compilation.
fn main() {
    gear_wasm_builder::build();
}
