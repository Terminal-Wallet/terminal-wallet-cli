{
  description = "A flake for terminal-wallet-cli";

  inputs = {
    nixpkgs.url = "nixpkgs/nixpkgs-unstable";
    flake-parts.url = "github:hercules-ci/flake-parts";
    nix-npm-buildpackage.url = "github:serokell/nix-npm-buildpackage";
  };

  outputs = inputs @ {...}:
    inputs.flake-parts.lib.mkFlake {inherit inputs;} {
      systems = ["x86_64-linux" "aarch64-linux" "aarch64-darwin" "x86_64-darwin"];
      perSystem = {pkgs, ...}: {
        devShells.default = pkgs.mkShell {
          buildInputs = with pkgs; [
            nodejs-18_x
            typescript
            nodePackages.eslint
            nodePackages.rimraf
          ];
        };
      };
    };
}
