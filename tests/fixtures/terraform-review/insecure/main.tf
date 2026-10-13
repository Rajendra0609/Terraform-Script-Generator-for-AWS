resource "aws_db_instance" "orders" {
  identifier          = "orders"
  publicly_accessible = true
  password            = "hunter2-do-not-commit"
}

resource "aws_security_group" "bastion" {
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
