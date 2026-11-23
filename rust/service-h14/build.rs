fn main() {
    if std::env::var("CARGO_CFG_TARGET_ARCH").as_deref() == Ok("wasm32") {
        println!("cargo:rustc-link-arg=--max-memory=201326592");
        println!("cargo:rustc-link-arg=-zstack-size=2097152");
    }
}
